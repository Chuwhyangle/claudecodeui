import fs from 'node:fs';
import path from 'node:path';

import { expect, request, test } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';

import {
  awaitClientMounted,
  warmClientStartup,
  type RequestFailure,
} from './support/client-startup-warmup';
import {
  writeFitContractFixture,
  type FitContractFixtureReading,
} from './support/architectureFixture';

/**
 * The architecture canvas's bottom-overlay layout criterion, on real pages.
 *
 * Three surfaces share the canvas's bottom band — the minimap, the zoom
 * cluster, the selection pill — and a fourth (the transient hover reading) is
 * placed against them. This file reads their SCREEN rectangles on the L
 * fixture (55 class entities) at the three viewports the task names and
 * asserts:
 *
 *  1. every pair is disjoint (1px tolerance). The defect was a minimap drawn
 *     over the zoom controls and a centred pill drawn over both. The FIFTH
 *     surface the task names, the bottom information bar, is the provenance
 *     footer; it is read and included pairwise wherever the tier draws it.
 *     The landscape phone folds that footer into the toolbar by an earlier
 *     landed criterion, so it has no bottom rect on that one tier and the
 *     four surfaces that exist everywhere are still checked;
 *  2. the zoom percentage is stated ONCE. The defect printed it in the tier
 *     row above the canvas and again inside the cluster;
 *  3. the minimap draws OUTLINES, not filled blocks;
 *  4. the hover reading is never hard-clipped: if its line overflows it is
 *     ellipsized and its `title` carries the whole reading.
 *
 * THE CONTROL ARM restores one defect per run through the DEV-only
 * `architecture-overlay-layout` lever, reloads, and reads with the SAME
 * `readOverlayLayout` function the main arm uses: the second percentage, the
 * solid minimap, and the un-slotted (centred, hint-ignoring) pill each have to
 * make their own reading go red.
 *
 * THE FIXTURE. `writeFitContractFixture` writes the same hub-and-spoke L tree
 * the fit-contract criterion measures (55 classes, five packages) under the
 * run's debug-agent fixture home; the seeded user text names the hub and one
 * leader per package so the server's extractor resolves them.
 */

const RUN_STARTED_AT = Number(process.env.QUAY_E2E_RUN_STARTED_AT) || Date.now();

const USERNAME = 'architecture-overlay-layout-e2e';
const PASSWORD = 'architecture-overlay-layout-e2e-pass';
const WORKSPACE_DIR = 'architecture-overlay-layout-workspace-l';

const SHOTS_DIR = path.resolve(process.cwd(), 'tmp', 'architecture-overlay-layout');

/** The three viewports the acceptance criterion names. */
const VIEWPORTS = [
  { name: 'pc', width: 1440, height: 765, touch: false },
  { name: 'phone-portrait', width: 390, height: 844, touch: true },
  { name: 'phone-landscape', width: 844, height: 390, touch: true },
] as const;

const SEL = {
  panel: '[data-workspace-view="architecture"] [data-architecture-panel]',
  canvasRegion: '[data-architecture-canvas-region]',
  host: '[data-architecture-plantuml]',
  graphRoot: '[data-architecture-plantuml-graph]',
  node: '.uml-node[data-entity-id]',
  minimap: '[data-architecture-minimap]',
  minimapCanvas: '[data-architecture-minimap-canvas]',
  minimapExpand: '[data-architecture-minimap-expand]',
  zoomCluster: '[data-architecture-zoom-cluster]',
  zoomClusterToggle: '[data-architecture-zoom-cluster-toggle]',
  zoomIn: '[data-architecture-zoom-in]',
  trayPill: '[data-architecture-tray-pill]',
  hoverHint: '[data-architecture-hover-hint]',
  hoverSpan: '[data-architecture-hover]',
  // The bottom information bar: the provenance footer under the canvas.
  bottomBar: '[data-architecture-source-footer]',
  zoomFit: '[data-architecture-zoom-fit]',
  fullscreenToggle: '[data-architecture-fullscreen-toggle]',
  fullscreenPanel: '[data-architecture-panel][data-architecture-fullscreen="true"]',
} as const;

/* ── the fixture ─────────────────────────────────────────────────────────────────────────── */

let reading: FitContractFixtureReading | null = null;
let sessionId = '';
let token = '';
let baseURL = '';

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

/** Arm a session whose seeded user text names the fixture's hub and leaders. */
async function armScenario(
  api: APIRequestContext,
  projectPath: string,
  seedIdentifiers: readonly string[],
): Promise<string> {
  const mentioned = seedIdentifiers.map((name) => `\`${name}\``).join(', ');
  const scenario = {
    version: 1,
    dialect: 'claude',
    home: 'gate',
    transcript: { mode: 'per-row-jsonl' },
    seed: { title: 'Architecture overlay layout', userText: `Review ${mentioned} before the refactor.` },
    steps: [{ at: 0, op: 'wait' }],
    expect: { rows: { delta: 0 }, content: { mustContain: [seedIdentifiers[0] ?? ''] } },
  };
  // One bounded retry: the scenario store has produced a transient 500 while a
  // previous run's fixture tree was still being scanned, and the second call
  // lands. A persistent failure still fails the run by name.
  let body: { data?: { sessionId?: unknown } } | null = null;
  let status = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await api.post('/api/debug-agent/scenarios', { data: { projectPath, scenario } });
    body = await response.json().catch(() => null);
    status = response.status();
    if (response.ok()) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
  if (status < 200 || status >= 300) throw new Error(`arming failed (${status}): ${JSON.stringify(body)}`);
  const id = body?.data?.sessionId;
  if (typeof id !== 'string') throw new Error(`arming returned no sessionId: ${JSON.stringify(body)}`);
  return id;
}

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

  const bootstrap = await request.newContext({ baseURL });
  token = await createAccount(bootstrap);
  await bootstrap.dispose();

  const api = await request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  try {
    const workspace = path.join(fixtureHome, WORKSPACE_DIR);
    reading = writeFitContractFixture(workspace, {
      entityCount: 55,
      entityKind: 'class',
      packageCount: 5,
      labelStem: 'Overlay',
    });
    sessionId = await armScenario(api, workspace, reading.seedIdentifiers);
    console.log(
      `[overlay-layout] fixture=L entities=${reading.entityTotal} seeds=${reading.seedIdentifiers.length} session=${sessionId}`,
    );
  } finally {
    await api.dispose();
  }
});

/* ── page driving ───────────────────────────────────────────────────────────────────────── */

let warmClientPromise: Promise<unknown> | null = null;

async function openContext(
  browser: Browser,
  viewport: (typeof VIEWPORTS)[number],
  defect: string | null = null,
): Promise<BrowserContext> {
  const dataDir = process.env.QUAY_E2E_DATA_DIR;
  if (!dataDir) throw new Error('playwright.config.ts must publish QUAY_E2E_DATA_DIR');
  warmClientPromise ??= warmClientStartup(baseURL, dataDir);
  await warmClientPromise;
  const context = await browser.newContext({
    baseURL,
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: viewport.touch,
    isMobile: viewport.touch,
  });
  await context.addInitScript(
    ({ authToken, overlayDefect }: { authToken: string; overlayDefect: string | null }) => {
      window.localStorage.setItem('auth-token', authToken);
      window.localStorage.setItem('userLanguage', 'en');
      // The DEV-only lever the control arm pulls. A fresh context is the only
      // way to make the shipped build read it before the first paint.
      if (overlayDefect !== null) {
        window.localStorage.setItem('architecture-overlay-layout', overlayDefect);
      } else {
        window.localStorage.removeItem('architecture-overlay-layout');
      }
      // A deterministic corner slot: the map always starts expanded here.
      window.localStorage.setItem('architecture.minimap.collapsed', 'expanded');
    },
    { authToken: token, overlayDefect: defect },
  );
  return context;
}

const startupEvidence: {
  pageErrors: string[];
  consoleErrors: string[];
  requestFailures: RequestFailure[];
  warmup: null;
} = { pageErrors: [], consoleErrors: [], requestFailures: [], warmup: null };

async function openSession(context: BrowserContext): Promise<Page> {
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
  await page.goto(`/session/${sessionId}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  try {
    await page.waitForFunction(
      () => [...document.querySelectorAll('[data-workspace-tab]')].some((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0
          && style.display !== 'none' && style.visibility !== 'hidden';
      }),
      undefined,
      { timeout: 60_000 },
    );
  } catch (error) {
    await awaitClientMounted(page, '[data-workspace-tab]', 1_000, startupEvidence);
    throw error;
  }
  return page;
}

async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await page.waitForTimeout(ms);
}

async function enterArchitecture(page: Page): Promise<void> {
  const direct = page.locator('[role="tab"][data-workspace-tab="architecture"]').first();
  if (await direct.count() === 0) {
    // The compact tier keeps its tabs in an overflow dialog.
    await page.locator('[aria-haspopup="dialog"][data-workspace-tab]').first().click();
    const inDialog = page.locator('[role="dialog"] [data-workspace-tab="architecture"]').first();
    await expect(inDialog).toBeVisible({ timeout: 15_000 });
    await inDialog.click();
  } else {
    await expect(direct).toBeVisible({ timeout: 30_000 });
    await direct.click();
  }
  await expect(page.locator(SEL.panel)).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    ({ root, host, node }) => Number(document.querySelector(root)?.getAttribute('data-architecture-visible-nodes') ?? '0') > 0
      && (document.querySelector(host)?.querySelectorAll(node).length ?? 0) > 0,
    { root: SEL.graphRoot, host: SEL.host, node: SEL.node },
    { timeout: 40_000 },
  );
  await settle(page, 600);
}

/**
 * Zoom until the drawing overflows its canvas and the minimap is drawn.
 *
 * A fitted semantic drawing can be shown 1:1 inside the canvas, in which case
 * the minimap (correctly) declines to draw at all; zooming in is what creates
 * the "where am I in the whole drawing" question the map exists to answer —
 * and it is one of the reader gestures the DoD walks.
 */
async function ensureMinimap(page: Page, expectedMode: 'outline' | 'solid' = 'outline'): Promise<void> {
  // The portrait phone ships the zoom cluster collapsed to one 44px button.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const toggle = page.locator(SEL.zoomClusterToggle).first();
    if (await toggle.count() === 0 || !(await toggle.isVisible())) break;
    await toggle.click();
    await settle(page, 250);
  }
  // A fitted drawing can be a pixel short of its host and still draw a
  // meaningless map; the minimap only earns its place after a REAL overflow.
  // Two steps also take the zoom out of the sticky `auto` state, so the dock
  // opening later cannot re-fit the drawing back under the viewport.
  for (let step = 0; step < 2; step += 1) {
    const zoomIn = page.locator(SEL.zoomIn).first();
    if (await zoomIn.count() === 0) break;
    await zoomIn.click({ timeout: 8_000 }).catch(() => undefined);
    await settle(page, 450);
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await page.locator(SEL.minimapCanvas).count() > 0) break;
    const expand = page.locator(SEL.minimapExpand).first();
    if (await expand.count() > 0 && await expand.isVisible()) {
      await expand.click();
      await settle(page, 250);
      continue;
    }
    const zoomIn = page.locator(SEL.zoomIn).first();
    if (await zoomIn.count() === 0) break;
    await zoomIn.click({ timeout: 8_000 }).catch(() => undefined);
    await settle(page, 450);
  }
  const expand = page.locator(SEL.minimapExpand).first();
  if (await expand.count() > 0 && await expand.isVisible()) {
    await expand.click();
    await settle(page, 300);
  }
  await expect(page.locator(SEL.minimapCanvas), 'the minimap canvas must be drawn').toBeVisible({
    timeout: 15_000,
  });
  await page.waitForFunction(
    ({ canvas, mode }) => document.querySelector(canvas)?.getAttribute('data-architecture-minimap-mode') === mode,
    { canvas: SEL.minimapCanvas, mode: expectedMode },
    { timeout: 15_000 },
  );
}

/**
 * The id of an entity box that is fully inside the canvas and above the bottom
 * band. Deliberately a DOM reading: Playwright's own actionability check refuses
 * a node the floating chrome covers, and this criterion is about exactly that
 * chrome.
 */
async function pickNode(page: Page): Promise<string> {
  const id = await page.evaluate(() => {
    const region = document.querySelector('[data-architecture-canvas-region]')?.getBoundingClientRect();
    if (!region) return null;
    const nodes = [...document.querySelectorAll('.uml-node[data-entity-id]')];
    const target = nodes.find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 4 && rect.height > 4
        && rect.left >= region.left && rect.right <= region.right
        && rect.top >= region.top + 20 && rect.bottom <= region.bottom - 64;
    });
    return target?.getAttribute('data-entity-id') ?? null;
  });
  if (id === null) throw new Error('no entity box inside the canvas above the bottom band');
  return id;
}

async function selectNode(page: Page): Promise<void> {
  const id = await pickNode(page);
  const clicked = await page.evaluate((entityId: string) => {
    const node = document.querySelector(`.uml-node[data-entity-id="${entityId}"]`);
    if (node === null) return false;
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  }, id);
  if (!clicked) throw new Error('the picked node vanished before the click');
}

async function hoverOtherNode(page: Page): Promise<void> {
  const id = await pickNode(page);
  const hovered = await page.evaluate((entityId: string) => {
    const node = document.querySelector(`.uml-node[data-entity-id="${entityId}"]`);
    if (node === null) return false;
    node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
    return true;
  }, id);
  if (!hovered) throw new Error('the picked node vanished before the hover');
}

/* ── the reading ────────────────────────────────────────────────────────────────────────── */

type Box = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
};

type OverlayLayoutReading = {
  readonly boxes: {
    readonly minimap: Box | null;
    readonly controls: Box | null;
    readonly bottomBar: Box | null;
    readonly pill: Box | null;
    readonly infoBar: Box | null;
  };
  /** Every element whose whole text is a bare percentage and is rendered. */
  readonly percentages: readonly string[];
  readonly minimapMode: string | null;
  readonly hint: {
    readonly text: string;
    readonly title: string;
    readonly truncated: boolean;
    readonly ellipsized: boolean;
  } | null;
  /** The names of every pair that shares more than 1px. */
  readonly overlaps: readonly string[];
};

/** ONE round trip: every reading below is taken from the SAME frame. */
async function readOverlayLayout(page: Page): Promise<OverlayLayoutReading> {
  return page.evaluate((sel) => {
    const toBox = (element: Element | null): Box | null => {
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const isRendered = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0
        && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
    };
    const boxes = {
      minimap: toBox(document.querySelector(sel.minimap)),
      controls: toBox(document.querySelector(sel.zoomCluster)),
      bottomBar: toBox(document.querySelector(sel.bottomBar)),
      pill: toBox(document.querySelector(sel.trayPill)),
      infoBar: toBox(document.querySelector(sel.hoverHint)),
    };
    const names = Object.keys(boxes) as (keyof typeof boxes)[];
    const overlaps: string[] = [];
    for (let first = 0; first < names.length; first += 1) {
      for (let second = first + 1; second < names.length; second += 1) {
        const a = boxes[names[first]];
        const b = boxes[names[second]];
        if (a === null || b === null) continue;
        const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (width > 1 && height > 1) overlaps.push(`${names[first]}x${names[second]}`);
      }
    }
    const panel = document.querySelector('[data-architecture-panel]');
    const percentages = panel === null
      ? []
      : [...panel.querySelectorAll('*')]
        .filter((element) => element.children.length === 0
          && /^\d+%$/.test((element.textContent ?? '').trim())
          && isRendered(element))
        .map((element) => (element.textContent ?? '').trim());
    const hintSpan = document.querySelector(sel.hoverSpan);
    const hintStyle = hintSpan === null ? null : getComputedStyle(hintSpan);
    const hint = hintSpan === null || hintStyle === null
      ? null
      : {
        text: hintSpan.textContent ?? '',
        title: hintSpan.getAttribute('title') ?? '',
        truncated: hintSpan.scrollWidth > hintSpan.clientWidth + 1,
        ellipsized: hintStyle.textOverflow === 'ellipsis'
          && hintStyle.overflow === 'hidden'
          && hintStyle.whiteSpace === 'nowrap',
      };
    return {
      boxes,
      percentages,
      minimapMode: document.querySelector(sel.minimapCanvas)?.getAttribute('data-architecture-minimap-mode') ?? null,
      hint,
      overlaps,
    };
  }, SEL);
}

/** Everything the main arm requires of one reading. */
function assertShippedLayout(label: string, state: OverlayLayoutReading): void {
  console.log(`[overlay-layout] ${label} ${JSON.stringify(state)}`);
  for (const name of ['minimap', 'controls', 'pill', 'infoBar'] as const) {
    const box = state.boxes[name];
    expect(box, `${label}: ${name} must be on screen`).not.toBeNull();
    expect(box?.width ?? 0, `${label}: ${name} has a width`).toBeGreaterThan(0);
    expect(box?.height ?? 0, `${label}: ${name} has a height`).toBeGreaterThan(0);
  }
  // The provenance footer is the task's fifth surface. It exists on every
  // tier except the landscape phone, which folds it into the toolbar.
  if (state.boxes.bottomBar !== null) {
    expect(state.boxes.bottomBar.width, `${label}: the bottom bar has a width`).toBeGreaterThan(0);
  } else {
    console.log(`[overlay-layout] ${label} bottomBar=folded-into-toolbar`);
  }
  expect(state.overlaps, `${label}: the bottom slots must be pairwise disjoint`).toEqual([]);
  expect(state.percentages.length, `${label}: one zoom percentage, got ${state.percentages.join(', ')}`).toBe(1);
  expect(state.minimapMode, `${label}: the minimap paints outlines`).toBe('outline');
  expect(state.hint, `${label}: the hover reading is drawn`).not.toBeNull();
  if (state.hint !== null) {
    expect(state.hint.title, `${label}: the title restates the reading`).toBe(state.hint.text);
    expect(state.hint.title.length, `${label}: the title is not empty`).toBeGreaterThan(0);
    if (state.hint.truncated) {
      expect(state.hint.ellipsized, `${label}: a clipped reading must be ellipsized`).toBe(true);
    }
  }
}

/** Drive one page to the state the reading is about. */
async function driveToReading(
  page: Page,
  expectedMode: 'outline' | 'solid' = 'outline',
  shotName: string | null = null,
): Promise<void> {
  await enterArchitecture(page);
  await ensureMinimap(page, expectedMode);
  // Before the selection opens the dock/drawer: the corner slot on its own.
  if (shotName !== null) await shot(page, `${shotName}-00-corner`);
  await selectNode(page);
  await expect(page.locator(SEL.trayPill), 'a selection draws its pill').toBeVisible({ timeout: 15_000 });
  await settle(page, 600);
  await hoverOtherNode(page);
  await expect(page.locator(SEL.hoverHint), 'hovering a node draws the reading').toBeVisible({ timeout: 15_000 });
  await settle(page, 500);
}

function shotDir(): void {
  // Screenshots are evidence for the task, not committed output.
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
}

async function shot(page: Page, name: string): Promise<void> {
  shotDir();
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
}

/* ── the main arm ───────────────────────────────────────────────────────────────────────── */

/**
 * The reader's other two gestures from the task's Definition of Done: Fit (the
 * whole drawing, the map correctly declines) and the fullscreen overlay (the
 * same one-percentage contract, with the toolbar row still its home).
 */
async function walkDodGestures(page: Page, viewport: (typeof VIEWPORTS)[number]): Promise<void> {
  // Fit through the canvas's own shortcut (`0`): on the portrait phone the
  // open drawer covers the cluster button, but the reader can still put the
  // whole drawing back — and that is exactly the state to photograph.
  await page.locator(SEL.host).first().focus();
  await page.keyboard.press('0');
  await settle(page, 550);
  const fitMode = await page.locator(SEL.graphRoot).getAttribute('data-architecture-fit');
  expect(fitMode, `${viewport.name}: the Fit gesture returns the canvas to auto`).toBe('auto');
  const fitted = await readOverlayLayout(page);
  expect(fitted.percentages.length, `${viewport.name}: Fit leaves ONE percentage`).toBe(1);
  await shot(page, `${viewport.name}-02-fit`);
  if (fitted.hint !== null) {
    expect(fitted.hint.title, `${viewport.name}: the title still restates the reading`).toBe(fitted.hint.text);
  }
  if (!viewport.touch) {
    const toggle = page.locator(SEL.fullscreenToggle).first();
    if (await toggle.count() > 0 && await toggle.isVisible()) {
      await toggle.click();
      await settle(page, 550);
      await expect(page.locator(SEL.fullscreenPanel), 'the overlay is entered').toHaveCount(1);
      const fullscreen = await readOverlayLayout(page);
      expect(fullscreen.percentages.length, `${viewport.name}: the overlay leaves ONE percentage`).toBe(1);
      await shot(page, `${viewport.name}-03-fullscreen`);
      await page.keyboard.press('Escape');
      await settle(page, 400);
    }
  }
}

test('main arm — the bottom slots are disjoint and the readout is single at three viewports', async ({ browser }) => {
  console.log(`[overlay-layout] run.startedAt=${RUN_STARTED_AT}`);
  for (const viewport of VIEWPORTS) {
    const context = await openContext(browser, viewport);
    try {
      const page = await openSession(context);
      await driveToReading(page, 'outline', viewport.name);
      const state = await readOverlayLayout(page);
      assertShippedLayout(viewport.name, state);
      await shot(page, `${viewport.name}-01-overlay-layout`);
      await walkDodGestures(page, viewport);
    } finally {
      await context.close();
    }
  }
});

/* ── the control arm ────────────────────────────────────────────────────────────────────── */

test('control arm — each restored defect reds its own reading', async ({ browser }) => {
  // 1. The second zoom percentage, on the desktop tier where the in-flow row
  //    is the shipped home.
  {
    const viewport = VIEWPORTS[0];
    const context = await openContext(browser, viewport, 'duplicate-readout');
    try {
      const page = await openSession(context);
      await driveToReading(page);
      const state = await readOverlayLayout(page);
      console.log(`[overlay-layout] control.duplicate-readout ${JSON.stringify(state.percentages)}`);
      expect(
        state.percentages.length,
        'the restored second readout must be visible, so the one-percentage assertion goes red',
      ).toBeGreaterThan(1);
      await shot(page, 'control-duplicate-readout');
    } finally {
      await context.close();
    }
  }

  // 2. The filled minimap blocks, on the desktop tier.
  {
    const viewport = VIEWPORTS[0];
    const context = await openContext(browser, viewport, 'solid-minimap');
    try {
      const page = await openSession(context);
      await driveToReading(page, 'solid');
      const state = await readOverlayLayout(page);
      console.log(`[overlay-layout] control.solid-minimap mode=${state.minimapMode}`);
      expect(state.minimapMode, 'the restored solid blocks must make the outline assertion go red').toBe('solid');
      await shot(page, 'control-solid-minimap');
    } finally {
      await context.close();
    }
  }

  // 3. The un-slotted pill: centred across the band and invisible to the hover
  //    placement. The portrait phone is where the centred pill shares the
  //    band with the lifted reading, so this is the pair that must go red.
  {
    const viewport = VIEWPORTS[1];
    const context = await openContext(browser, viewport, 'no-slot-layout');
    try {
      const page = await openSession(context);
      await driveToReading(page);
      const state = await readOverlayLayout(page);
      console.log(`[overlay-layout] control.no-slot-layout overlaps=${JSON.stringify(state.overlaps)}`);
      expect(
        state.overlaps.some((pair) => pair.includes('infoBar') && pair.includes('pill')),
        `the restored shared-space layout must make the pairwise-disjoint assertion go red; got ${JSON.stringify(state.overlaps)}`,
      ).toBe(true);
      await shot(page, 'control-no-slot-layout');
    } finally {
      await context.close();
    }
  }
});
