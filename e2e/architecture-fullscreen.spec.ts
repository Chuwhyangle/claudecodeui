import fs from 'node:fs';
import path from 'node:path';

import { expect, request, test } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';

import {
  awaitClientMounted,
  warmClientStartup,
  type RequestFailure,
} from './support/client-startup-warmup';

/**
 * The architecture tab's fullscreen criterion, on real pages.
 *
 * The jsdom case proves the wiring; this file proves the GEOMETRY the task is
 * about. Three viewports — PC 1440×765, phone portrait 390×844 and phone
 * landscape 844×390 — enter the overlay and read:
 *
 *  1. the drawing host's rectangle equals the viewport (±1px). That is the
 *     whole point of the feature: the 844×390 phone used to give the drawing
 *     555×162, and the overlay must give it the screen;
 *  2. the sidebar and the header are covered AND inert — painted-over alone
 *     would still leave them tabbable;
 *  3. a selection and a custom zoom survive entering and exiting;
 *  4. exiting restores the layout the page had before entering;
 *  5. Escape exits the overlay without reaching a document-level listener.
 *
 * The last case starts a real turn, walks into the overlay and presses Escape:
 * the chat page's global Escape abort key must never see the key. Its control
 * arm removes `stopPropagation` (by making `Event.prototype.stopPropagation` a
 * no-op in the page) and re-runs the same reading, which must then go red.
 *
 * THE FIXTURE. A small `.archguard` tree (three entities) is written under the
 * run's debug-agent fixture home before the scenario is armed; the seeded user
 * text names the fixture's entities so the server's extractor resolves them.
 */

const RUN_STARTED_AT = Number(process.env.QUAY_E2E_RUN_STARTED_AT) || Date.now();

/** The three viewports the task names. */
const VIEWPORT_PC = { width: 1440, height: 765 };
const VIEWPORT_PHONE_PORTRAIT = { width: 390, height: 844 };
const VIEWPORT_PHONE_LANDSCAPE = { width: 844, height: 390 };

const USERNAME = 'architecture-fullscreen-e2e';
const PASSWORD = 'architecture-fullscreen-e2e-pass';
const WORKSPACE_DIR = 'architecture-fullscreen-workspace';

/** Where the DoD's screenshots land (git-ignored). */
const SHOTS_DIR = path.resolve(process.cwd(), 'tmp', 'architecture-fullscreen');

const SEL = {
  panel: '[data-workspace-view="architecture"] [data-architecture-panel]',
  overlay: '[data-architecture-panel][data-architecture-fullscreen="true"]',
  toggle: '[data-architecture-fullscreen-toggle]',
  canvas: '[data-architecture-canvas-region]',
  host: '[data-architecture-plantuml]',
  graphRoot: '[data-architecture-plantuml-graph]',
  node: '.uml-node[data-entity-id]',
  zoomIn: '[data-architecture-zoom-in]',
  trayPill: '[data-architecture-tray-pill]',
  inspector: '[role="complementary"]',
  header: '[data-app-header]',
  composer: 'textarea[data-slot="prompt-input-textarea"]',
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
  { id: 'src/alpha/alpha.ts.Alpha', name: 'Alpha', file: 'src/alpha/alpha.ts', kind: 'class', parents: [] },
  { id: 'src/alpha/beta.ts.Beta', name: 'Beta', file: 'src/alpha/beta.ts', kind: 'class', parents: ['src/alpha/alpha.ts.Alpha'] },
  { id: 'src/beta/gamma.ts.Gamma', name: 'Gamma', file: 'src/beta/gamma.ts', kind: 'interface', parents: ['src/alpha/beta.ts.Beta'] },
];

const SEED_NAME = 'Alpha';
const SECOND_NAME = 'Beta';

const SCOPE_KEY = 'scope-src';
const ARCH_JSON_HASH = 'c7c1f0d4b8e29365f0d4b8e29365a7c1f0d4b8e29365a7c1f0d4b8e29365a7c3';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Write the three-entity analysis tree the server reads (the ArchGuard shape). */
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

/** Arm a session whose seeded user text names the fixture's entities. */
async function armScenario(
  api: APIRequestContext,
  projectPath: string,
  options: { holdMs: number },
): Promise<string> {
  const scenario = {
    version: 1,
    dialect: 'claude',
    home: 'gate',
    transcript: { mode: 'per-row-jsonl' },
    seed: {
      title: 'Architecture fullscreen',
      userText: `Please review \`${SEED_NAME}\` and \`${SECOND_NAME}\` before the refactor.`,
    },
    // Two waits hold a sent turn open for the running-turn case; the geometry
    // cases never send, so the first wait is all that is ever spent.
    steps: [
      { at: 0, op: 'wait' },
      { at: options.holdMs, op: 'wait' },
    ],
    expect: { rows: { delta: 0 }, content: { mustContain: [SEED_NAME] } },
  };
  const response = await api.post('/api/debug-agent/scenarios', { data: { projectPath, scenario } });
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`arming failed (${response.status()}): ${JSON.stringify(body)}`);
  }
  const sessionId = body?.data?.sessionId;
  if (typeof sessionId !== 'string') {
    throw new Error(`arming returned no sessionId: ${JSON.stringify(body)}`);
  }
  return sessionId;
}

/* ── page setup ─────────────────────────────────────────────────────────────────────────── */

const startupEvidence: {
  pageErrors: string[];
  consoleErrors: string[];
  requestFailures: RequestFailure[];
  warmup: null;
} = { pageErrors: [], consoleErrors: [], requestFailures: [], warmup: null };

let warmClientPromise: Promise<unknown> | null = null;

async function openSignedInPage(
  browser: Browser,
  baseURL: string,
  token: string,
  viewport: { width: number; height: number },
): Promise<{ context: BrowserContext; page: Page }> {
  const dataDir = process.env.QUAY_E2E_DATA_DIR;
  if (!dataDir) throw new Error('playwright.config.ts must publish QUAY_E2E_DATA_DIR');
  warmClientPromise ??= warmClientStartup(baseURL, dataDir);

  const context = await browser.newContext({
    baseURL,
    viewport,
    hasTouch: viewport.width < 1000,
    isMobile: viewport.width < 1000,
  });
  await context.addInitScript(
    ({ authKey, authToken }: { authKey: string; authToken: string }) => {
      window.localStorage.setItem(authKey, authToken);
      window.localStorage.setItem('userLanguage', 'en');
    },
    { authKey: 'auth-token', authToken: token },
  );
  // Deterministic overlay-only runs. The browser's native fullscreen session
  // would take Escape for itself and hide whether THIS page stopped the key at
  // the overlay; the native request is the unit test's subject.
  await context.addInitScript(() => {
    Object.defineProperty(Element.prototype, 'requestFullscreen', {
      configurable: true,
      value: undefined,
    });
  });
  const page = await context.newPage();
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
  return { context, page };
}

const ARCHITECTURE_TAB_LANDING =
  '[role="tab"][data-workspace-tab="architecture"], [aria-haspopup="dialog"][data-workspace-tab]';

type Box = { x: number; y: number; width: number; height: number; right: number; bottom: number };

async function settle(page: Page, ms = 300): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await page.waitForTimeout(ms);
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
}

/** Open the architecture tab (desktop pill, or the phone picker). */
async function enterArchitecture(page: Page): Promise<void> {
  const desktopTab = page.locator('[role="tab"][data-workspace-tab="architecture"]');
  if ((await desktopTab.count()) > 0 && (await desktopTab.first().isVisible())) {
    await desktopTab.first().click();
  } else {
    await page.locator('[aria-haspopup="dialog"][data-workspace-tab]').first().click();
    await page.locator('[role="dialog"] [data-workspace-tab="architecture"]').first().click();
  }
  await expect(page.locator(SEL.panel), 'the architecture tab must open for the fixture project').toBeVisible({
    timeout: 30_000,
  });
  await page.waitForFunction(
    (sel) => {
      const root = document.querySelector(sel.graphRoot);
      const host = document.querySelector(sel.host);
      return Number(root?.getAttribute('data-architecture-visible-nodes') ?? '0') > 0
        && (host?.querySelectorAll(sel.node).length ?? 0) > 0;
    },
    SEL,
    { timeout: 40_000 },
  );
  await settle(page, 500);
}

/** Make sure the drawn entity boxes are on screen (never asserts a state into existence). */
async function showEntityBoxes(page: Page): Promise<void> {
  const node = page.locator(`.uml-node[data-entity-id$=".${SEED_NAME}"]`).first();
  const visible = async (): Promise<boolean> => (await node.count()) > 0 && (await node.isVisible());
  for (let attempt = 0; attempt < 8 && !(await visible()); attempt += 1) {
    const zoomIn = page.locator(SEL.zoomIn);
    if ((await zoomIn.count()) === 0) break;
    await zoomIn.first().click();
    await page.waitForTimeout(180);
  }
  await expect(node, 'the selected entity must be a drawn box').toBeVisible({ timeout: 20_000 });
  await node.click();
  await settle(page, 300);
}

/**
 * Put the drawing in CUSTOM zoom before selecting anything. It must happen
 * before the selection: selecting opens the phone drawer/tray over the canvas
 * cluster, and a click on the zoom button would then be intercepted.
 */
async function customZoom(page: Page): Promise<void> {
  await page.locator(SEL.zoomIn).first().click();
  await settle(page, 300);
}

type FullscreenReading = {
  readonly active: boolean;
  readonly viewport: { width: number; height: number };
  readonly panel: Box | null;
  readonly canvas: Box | null;
  readonly host: Box | null;
  readonly zoomScale: string | null;
  readonly zoomMode: string | null;
  readonly trayPill: string | null;
  readonly inspectorVisible: boolean;
  readonly headerOccluded: boolean;
  readonly headerInert: boolean;
  readonly sidebarOccluded: boolean;
  readonly sidebarInert: boolean;
  readonly focusInCanvas: boolean;
};

/** Everything one fullscreen state reports, in a single round trip. */
async function readFullscreen(page: Page): Promise<FullscreenReading> {
  return page.evaluate((sel) => {
    const box = (target: Element | null): Box | null => {
      if (target === null) return null;
      const rect = target.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom,
      };
    };
    const panel = document.querySelector('[data-architecture-panel]');
    const active = panel?.getAttribute('data-architecture-fullscreen') === 'true';
    const canvas = document.querySelector(sel.canvas);
    const header = document.querySelector(sel.header);
    // The sidebar region is the shell's first child on both tiers.
    const sidebar = document.querySelector('[data-app-shell]')?.firstElementChild ?? null;
    const isInert = (target: Element | null): boolean =>
      target !== null && (target.hasAttribute('inert') || target.closest('[inert]') !== null);
    /** True when the point this element centres on is the overlay's, not the element's. */
    const occluded = (target: Element | null): boolean => {
      if (target === null || panel === null) return false;
      const rect = target.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;
      const x = rect.left + Math.min(40, rect.width / 2);
      const y = rect.top + Math.min(40, rect.height / 2);
      const hit = document.elementFromPoint(x, y);
      return hit !== null && panel.contains(hit);
    };
    const graphRoot = document.querySelector(sel.graphRoot);
    return {
      active,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      panel: box(panel),
      canvas: box(canvas),
      host: box(document.querySelector(sel.host)),
      zoomScale: graphRoot?.getAttribute('data-architecture-zoom-scale') ?? null,
      zoomMode: graphRoot?.getAttribute('data-architecture-zoom-mode') ?? null,
      trayPill: document.querySelector(sel.trayPill)?.textContent ?? null,
      inspectorVisible: document.querySelector(sel.inspector) !== null,
      headerOccluded: occluded(header),
      headerInert: isInert(header),
      sidebarOccluded: occluded(sidebar),
      sidebarInert: isInert(sidebar),
      focusInCanvas: canvas !== null && canvas.contains(document.activeElement),
    };
  }, SEL);
}

function formatBox(value: Box | null): string {
  if (value === null) return 'null';
  return `${Math.round(value.width)}x${Math.round(value.height)}@${Math.round(value.x)},${Math.round(value.y)}`;
}

function expectSameBox(actual: Box | null, expected: Box | null, label: string): void {
  if (actual === null || expected === null) {
    expect(actual, `${label}: a rectangle must be readable on both sides`).not.toBeNull();
    return;
  }
  expect(Math.abs(actual.x - expected.x), `${label}: x must be restored (${formatBox(actual)} vs ${formatBox(expected)})`).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.y - expected.y), `${label}: y must be restored (${formatBox(actual)} vs ${formatBox(expected)})`).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.width - expected.width), `${label}: width must be restored (${formatBox(actual)} vs ${formatBox(expected)})`).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.height - expected.height), `${label}: height must be restored (${formatBox(actual)} vs ${formatBox(expected)})`).toBeLessThanOrEqual(1);
}

/** Enter the overlay with the toolbar control and read it back. */
async function enterOverlay(page: Page, label: string): Promise<FullscreenReading> {
  await page.locator(SEL.toggle).first().click();
  await expect(page.locator(SEL.overlay), `${label}: the toolbar button must open the overlay`).toBeVisible({
    timeout: 10_000,
  });
  await settle(page, 600);
  const reading = await readFullscreen(page);
  console.log(`[architecture-fullscreen] ${label}.enter=${JSON.stringify({ ...reading, panel: formatBox(reading.panel), canvas: formatBox(reading.canvas), host: formatBox(reading.host) })}`);
  return reading;
}

/** The three-viewport geometry legs, one real page each. */
async function runGeometryCriterion(
  page: Page,
  label: string,
  viewport: { width: number; height: number },
): Promise<void> {
  const before = await readFullscreen(page);
  expect(before.active, `${label}: the page starts outside the overlay`).toBe(false);
  expect(before.host, `${label}: the drawing host must exist`).not.toBeNull();

  const inside = await enterOverlay(page, label);
  await shot(page, `${label}-01-overlay`);

  // 1. The overlay and the drawing host both cover the viewport.
  expect(inside.panel, `${label}: the overlay must have a box`).not.toBeNull();
  expect(Math.abs((inside.panel as Box).width - viewport.width), `${label}: overlay width ${formatBox(inside.panel)} vs ${viewport.width}`).toBeLessThanOrEqual(1);
  expect(Math.abs((inside.panel as Box).height - viewport.height), `${label}: overlay height ${formatBox(inside.panel)} vs ${viewport.height}`).toBeLessThanOrEqual(1);
  expect(inside.host, `${label}: the drawing host must have a box`).not.toBeNull();
  expect(
    Math.abs((inside.host as Box).width - viewport.width),
    `${label}: the drawing host must span the viewport width — host=${formatBox(inside.host)} viewport=${viewport.width}x${viewport.height}`,
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs((inside.host as Box).height - viewport.height),
    `${label}: the drawing host must span the viewport height — host=${formatBox(inside.host)} viewport=${viewport.width}x${viewport.height}`,
  ).toBeLessThanOrEqual(1);

  // 2. The covered shell is not merely painted over: it is inert, and the
  //    points its controls occupy belong to the overlay.
  expect(inside.headerInert, `${label}: the header behind the overlay must be inert`).toBe(true);
  expect(inside.sidebarInert, `${label}: the sidebar behind the overlay must be inert`).toBe(true);
  expect(inside.headerOccluded, `${label}: the header's point must belong to the overlay`).toBe(true);
  expect(inside.sidebarOccluded, `${label}: the sidebar's point must belong to the overlay`).toBe(true);

  // 3. Selection and zoom survive the toggle.
  expect(inside.trayPill, `${label}: the selection tray must survive entering`).not.toBeNull();
  expect(inside.trayPill, `${label}: the selection tray must still name one selected entity`).toContain('1');
  expect(inside.zoomScale, `${label}: the zoom reading must survive entering`).toBe(before.zoomScale);
  expect(inside.focusInCanvas, `${label}: focus moves into the drawing on entry`).toBe(true);

  // 4. Escape exits and the layout comes back.
  await page.keyboard.press('Escape');
  await expect(page.locator(SEL.overlay), `${label}: Escape must close the overlay`).toHaveCount(0, { timeout: 10_000 });
  await settle(page, 500);
  const after = await readFullscreen(page);
  await shot(page, `${label}-02-restored`);
  expect(after.active, `${label}: the panel is back in its normal layout`).toBe(false);
  expect(after.trayPill, `${label}: the selection survives the exit too`).not.toBeNull();
  expect(after.zoomScale, `${label}: the zoom survives the exit`).toBe(inside.zoomScale);
  expectSameBox(after.canvas, before.canvas, `${label}: the canvas layout`);

  console.log(
    `[architecture-fullscreen] ${label} hostOut=${formatBox(inside.host)} viewport=${viewport.width}x${viewport.height} `
      + `canvasIn=${formatBox(before.canvas)} canvasOut=${formatBox(after.canvas)} zoom=${inside.zoomScale}`,
  );
}

let baseURL = '';
let sessionId = '';
let token = '';
let workspaceDir = '';

test.beforeAll(async () => {
  baseURL = test.info().project.use.baseURL ?? '';
  if (baseURL === '') throw new Error('playwright.config.ts must give this project a baseURL');
  const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
  if (!fixtureHome) {
    throw new Error(
      'playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME for this selection '
        + '(the fullscreen spec is listed in DEBUG_AGENT_SPEC_FILES)',
    );
  }
  workspaceDir = path.join(fixtureHome, WORKSPACE_DIR);
  writeFixture(workspaceDir);

  const bootstrap = await request.newContext({ baseURL });
  token = await createAccount(bootstrap);
  await bootstrap.dispose();

  const api = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  sessionId = await armScenario(api, workspaceDir, { holdMs: 30_000 });
  await api.dispose();
  console.log(`[architecture-fullscreen] fixture.entities=${ENTITIES.length} session=${sessionId}`);
});

test('PC 1440x765: the overlay gives the drawing the whole viewport, and the layout comes back', async ({ browser }) => {
  const { context, page } = await openSignedInPage(browser, baseURL, token, VIEWPORT_PC);
  try {
    await page.goto(`/session/${sessionId}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await awaitClientMounted(page, ARCHITECTURE_TAB_LANDING, 25_000, startupEvidence);
    await enterArchitecture(page);
    // A custom zoom (not `fit`) is what the toggle must preserve; it is set
    // before the selection so the phone drawer cannot cover the control.
    await customZoom(page);
    await showEntityBoxes(page);
    await runGeometryCriterion(page, 'pc', VIEWPORT_PC);
  } finally {
    await context.close();
  }
});

test('phone portrait 390x844: the overlay fills the screen and restores it', async ({ browser }) => {
  const { context, page } = await openSignedInPage(browser, baseURL, token, VIEWPORT_PHONE_PORTRAIT);
  try {
    await page.goto(`/session/${sessionId}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await awaitClientMounted(page, ARCHITECTURE_TAB_LANDING, 25_000, startupEvidence);
    await enterArchitecture(page);
    // `fit` is expected to re-fit when the container becomes the viewport; a
    // CUSTOM zoom is what the toggle must preserve.
    await customZoom(page);
    await showEntityBoxes(page);
    await runGeometryCriterion(page, 'phone-portrait', VIEWPORT_PHONE_PORTRAIT);
  } finally {
    await context.close();
  }
});

test('phone landscape 844x390: the drawing is the screen, far past the old 555x162', async ({ browser }) => {
  const { context, page } = await openSignedInPage(browser, baseURL, token, VIEWPORT_PHONE_LANDSCAPE);
  try {
    await page.goto(`/session/${sessionId}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await awaitClientMounted(page, ARCHITECTURE_TAB_LANDING, 25_000, startupEvidence);
    await enterArchitecture(page);
    // A custom zoom, as in the other viewports.
    await customZoom(page);
    await showEntityBoxes(page);
    await runGeometryCriterion(page, 'phone-landscape', VIEWPORT_PHONE_LANDSCAPE);
  } finally {
    await context.close();
  }
});

test('Escape exits without reaching the chat page\'s global Escape (and the control arm goes red)', async ({ browser }) => {
  // Arm a FRESH session for this case, right before sending: the debug-agent
  // scenario clock starts at arming, so a session armed in `beforeAll` would
  // already have walked past its waits by the time the fourth case runs and
  // the sent turn would finish immediately.
  const armApi = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  const turnSessionId = await armScenario(armApi, workspaceDir, { holdMs: 120_000 });
  await armApi.dispose();

  const { context, page } = await openSignedInPage(browser, baseURL, token, VIEWPORT_PHONE_PORTRAIT);
  try {
    await page.goto(`/session/${turnSessionId}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await awaitClientMounted(page, SEL.composer, 25_000, startupEvidence);

    // Start a real turn: the scenario's second wait holds it open while we walk
    // away, which is the state the criterion is about. The Send BUTTON is used
    // rather than an Enter keypress: on a touch tier the composer owns Enter
    // for its own behaviour, and the criterion is about what Escape does, not
    // about how the message is submitted.
    const composer = page.locator(SEL.composer);
    await composer.fill('hold this turn open for the fullscreen Escape criterion');
    await page.locator('button[aria-label="Send"]').first().click();
    // Scoped to the composer FORM: the activity indicator carries a second
    // "Stop" control (hidden behind the architecture tab), and an unscoped
    // locator would read that one instead of the turn's own state.
    const composerStop = page.locator('form[data-slot="prompt-input"] button[aria-label="Stop"]');
    await expect(
      composerStop,
      'the sent turn must still be running when the overlay is entered',
    ).toBeVisible({ timeout: 30_000 });
    await settle(page, 300);

    // The page's own document-level Escape counter. The overlay's handler runs
    // at the window's capture phase, so this listener must never see the key.
    const documentEscapes: string[] = [];
    await page.exposeFunction('recordDocumentEscape', (value: string) => documentEscapes.push(value));
    await page.evaluate(() => {
      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        (window as unknown as { recordDocumentEscape: (value: string) => void }).recordDocumentEscape('chat.abort');
      });
    });

    await enterArchitecture(page);
    await enterOverlay(page, 'escape-phone');
    await shot(page, 'escape-01-overlay-running-turn');
    await page.keyboard.press('Escape');
    await expect(page.locator(SEL.overlay), 'Escape exits the overlay').toHaveCount(0, { timeout: 10_000 });
    await settle(page, 200);
    expect(documentEscapes, 'Escape must not reach the chat page\'s document listener').toEqual([]);
    // The turn is still running behind the page. The chat pane stays mounted
    // (hidden) while the architecture tab is active, so its submit label is the
    // live reading: "Stop" while the turn runs, "Send" once it is over.
    await expect(
      composerStop,
      'the running turn must not be aborted by the overlay Escape',
    ).toHaveCount(1, { timeout: 10_000 });
    await shot(page, 'escape-02-turn-still-running');

    // Control arm: remove stopPropagation from the page and re-run the same
    // reading. The SAME counter must now go red, then green again once the
    // mechanism is back.
    await page.evaluate(() => {
      const original = Event.prototype.stopPropagation;
      (window as unknown as { __restoreStopPropagation: () => void }).__restoreStopPropagation = () => {
        Event.prototype.stopPropagation = original;
      };
      Event.prototype.stopPropagation = function noopStopPropagation() {};
    });
    await enterOverlay(page, 'control-arm');
    await page.keyboard.press('Escape');
    await expect(page.locator(SEL.overlay), 'the control arm still exits the overlay').toHaveCount(0, { timeout: 10_000 });
    await settle(page, 200);
    expect(documentEscapes.length, 'control: without stopPropagation Escape reaches the document listener').toBeGreaterThan(0);
    await page.evaluate(() => {
      (window as unknown as { __restoreStopPropagation: () => void }).__restoreStopPropagation();
    });

    const beforeGreen = documentEscapes.length;
    await enterOverlay(page, 'restored-arm');
    await page.keyboard.press('Escape');
    await expect(page.locator(SEL.overlay), 'the restored mechanism exits the overlay').toHaveCount(0, { timeout: 10_000 });
    await settle(page, 200);
    expect(
      documentEscapes.length,
      'restoring stopPropagation keeps the document listener out of it again',
    ).toBe(beforeGreen);

    const elapsed = Date.now() - RUN_STARTED_AT;
    console.log(`[architecture-fullscreen] elapsed=${elapsed}ms`);
    expect.soft(
      elapsed,
      `the criterion has to end inside the declared single-file budget; measured ${elapsed}ms`,
    ).toBeLessThan(240_000);
  } finally {
    await context.close();
  }
});
