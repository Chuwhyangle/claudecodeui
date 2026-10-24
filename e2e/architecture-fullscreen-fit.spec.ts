import fs from 'node:fs';
import path from 'node:path';

import { expect, request, test } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';

import { writeFitContractFixture, type FitContractFixtureReading } from './support/architectureFixture';
import { awaitClientMounted, warmClientStartup, type RequestFailure } from './support/client-startup-warmup';

/**
 * The fullscreen Fit area, in a real browser.
 *
 * WHAT IT PROVES. On the page-internal overlay the canvas IS the viewport, so
 * Fit's available area is the host rectangle less the chrome measured over it
 * (the toolbar/readout band and the floating corner slot) — NOT the constant
 * margin the in-flow layout reserves around its drawing. The L fixture (55
 * entities) must therefore fill at least 85 % of the measured area on its
 * limiting dimension, keep its floor font, and never be drawn under the chrome.
 *
 * THE SHAPES. Four viewports (1440×765, 1920×900, 390×844, 844×390), one real
 * page each, one reading after entering fullscreen and pressing Fit.
 *
 * THE READING. One `page.evaluate` per state, because the claim is a relation
 * between boxes that must be read on one frame. The available area is computed
 * page-side by `availableFitArea`, a verbatim mirror of
 * `solveFitArea` in `src/modules/architecture/semanticZoomLayout.ts` — the e2e
 * tree does not import the app's `@`-aliased modules. The app also publishes
 * the box it solved against as `data-architecture-fit-viewport`; the reading
 * asserts the two agree, so the measurement cannot silently drift from the
 * product's own arithmetic.
 *
 * THE CONTROL ARM. The same reading function, on a page that pulls the
 * DEV-only `architecture-fullscreen-fit-margins=reserved` lever: Fit then
 * keeps the retired non-fullscreen canvas, the drawn share of the measured
 * area drops below the 85 % floor, and removing the lever returns it.
 */

const RUN_STARTED_AT = Number(process.env.QUAY_E2E_RUN_STARTED_AT) || Date.now();

test.describe.configure({ timeout: 240_000 });

const USERNAME = 'architecture-fullscreen-fit-e2e';
const PASSWORD = 'architecture-fullscreen-fit-e2e-pass';

/** The four viewports the criterion is stated on. */
const VIEWPORTS = [
  { name: 'pc-1440x765', width: 1440, height: 765, touch: false },
  { name: 'pc-1920x900', width: 1920, height: 900, touch: false },
  { name: 'phone-390x844', width: 390, height: 844, touch: true },
  { name: 'phone-844x390', width: 844, height: 390, touch: true },
] as const;

/** The smallest screen font the canvas may draw. */
const PC_FLOOR_PX = 10;
const PHONE_FLOOR_PX = 11;

/** A fitted drawing fills at least this share of the measured area's limiting dimension. */
const MIN_FILL_RATIO = 0.85;

/** How far a box may stray from the measured area (the renderer rounds up). */
const FIT_TOLERANCE_PX = 2;

const SHOTS_DIR = path.resolve(process.cwd(), 'tmp', 'architecture-fullscreen-fit');

const SEL = {
  panel: '[data-architecture-panel]',
  fullscreenPanel: '[data-architecture-panel][data-architecture-fullscreen="true"]',
  host: '[data-architecture-plantuml]',
  graphRoot: '[data-architecture-plantuml-graph]',
  toolbar: '[data-architecture-toolbar]',
  header: '[data-architecture-canvas-header]',
  overlays: '[data-architecture-canvas-overlays]',
  tray: '[data-architecture-tray-root]',
  footer: '[data-architecture-source-footer]',
  fullscreenToggle: '[data-architecture-fullscreen-toggle]',
  zoomFit: '[data-architecture-zoom-fit]',
  sheetToggle: '[data-architecture-sheet-toggle]',
  sheet: '[data-architecture-sheet]',
  sheetClose: '[data-architecture-sheet-close]',
  node: '.uml-node[data-entity-id]',
} as const;

/* ── fixture + session setup ─────────────────────────────────────────────────────────────── */

type Box = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
};

type FullscreenFitReading = {
  readonly host: Box;
  readonly drawing: Box | null;
  readonly overlays: readonly Box[];
  readonly available: Box;
  readonly fill: number;
  readonly minFontPx: number;
  readonly appViewport: string | null;
  readonly tier: string | null;
  readonly scale: number;
  readonly overflowX: number;
  readonly overflowY: number;
};

const WORKSPACE = 'architecture-fullscreen-fit-workspace-l';

let fixture: FitContractFixtureReading | null = null;
let sessionId = '';
let token = '';
let baseURL = '';
let warmClientPromise: Promise<unknown> | null = null;

const startupEvidence = {
  pageErrors: [] as string[],
  consoleErrors: [] as string[],
  requestFailures: [] as RequestFailure[],
};

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
    seed: { title: 'Architecture fullscreen fit', userText: `Review ${mentioned} before the refactor.` },
    steps: [{ at: 0, op: 'wait' }],
    expect: { rows: { delta: 0 }, content: { mustContain: [seedIdentifiers[0] ?? ''] } },
  };
  const response = await api.post('/api/debug-agent/scenarios', { data: { projectPath, scenario } });
  const body = await response.json().catch(() => null);
  if (!response.ok()) throw new Error(`arming failed (${response.status()}): ${JSON.stringify(body)}`);
  const armed = body?.data?.sessionId;
  if (typeof armed !== 'string') throw new Error(`arming returned no sessionId: ${JSON.stringify(body)}`);
  return armed;
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

  const workspace = path.join(fixtureHome, WORKSPACE);
  // L: 55 classes over five packages — the shape the proposal measured.
  fixture = writeFitContractFixture(workspace, {
    entityCount: 55,
    entityKind: 'class',
    packageCount: 5,
    labelStem: 'FitL',
  });
  const api = await request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  try {
    sessionId = await armScenario(api, workspace, fixture.seedIdentifiers);
  } finally {
    await api.dispose();
  }
  console.log(`[fullscreen-fit] fixture entities=${fixture.entityTotal} session=${sessionId}`);
});

/* ── the reading ───────────────────────────────────────────────────────────────────────── */

/**
 * One round trip: every number below is read from the SAME frame.
 *
 * `availableFitArea` mirrors `solveFitArea` from the app: each measured overlay
 * removes the cheapest of the four host edge-bands that contains it. Kept in
 * the spec because the e2e tree does not resolve the app's `@` alias; the
 * product's own answer is read back as `data-architecture-fit-viewport` and
 * compared, which is what keeps the two from drifting apart unnoticed.
 */
async function readFullscreenFit(page: Page): Promise<FullscreenFitReading> {
  return page.evaluate((sel) => {
    const boxOf = (rect: { left: number; top: number; width: number; height: number }) => ({
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
    });
    const availableFitArea = (
      host: { width: number; height: number },
      overlays: readonly { left: number; top: number; width: number; height: number }[],
    ) => {
      const width = Math.max(0, host.width);
      const height = Math.max(0, host.height);
      if (!(width > 0) || !(height > 0)) return { left: 0, top: 0, width, height };
      let left = 0;
      let right = width;
      let top = 0;
      let bottom = height;
      for (const overlay of overlays) {
        const l = Math.max(0, Math.min(width, overlay.left));
        const r = Math.max(0, Math.min(width, overlay.left + overlay.width));
        const t = Math.max(0, Math.min(height, overlay.top));
        const b = Math.max(0, Math.min(height, overlay.top + overlay.height));
        if (r <= l || b <= t) continue;
        const costs = { top: b, right: width - l, bottom: height - t, left: r };
        const cheapest = (['top', 'right', 'bottom', 'left'] as const)
          .reduce((best, edge) => (costs[edge] < costs[best] ? edge : best), 'top');
        if (cheapest === 'top') top = Math.max(top, b);
        else if (cheapest === 'right') right = Math.min(right, l);
        else if (cheapest === 'bottom') bottom = Math.min(bottom, t);
        else left = Math.max(left, r);
      }
      left = Math.min(left, right);
      top = Math.min(top, bottom);
      return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
    };

    const panel = document.querySelector<HTMLElement>(sel.fullscreenPanel)
      ?? document.querySelector<HTMLElement>(sel.panel);
    const host = panel?.querySelector<HTMLElement>(sel.host) ?? null;
    const root = panel?.querySelector<HTMLElement>(sel.graphRoot) ?? null;
    const hostRect = host?.getBoundingClientRect();
    if (panel === null || host === null || hostRect === undefined) {
      throw new Error('the fullscreen canvas is not on the page');
    }
    const hostBox = boxOf(hostRect);
    const overlays: ReturnType<typeof boxOf>[] = [];
    const addOverlay = (rect: DOMRect): void => {
      if (!(rect.width > 0) || !(rect.height > 0)) return;
      const clipped = boxOf({
        left: Math.max(hostBox.left, rect.left),
        top: Math.max(hostBox.top, rect.top),
        width: 0,
        height: 0,
      });
      clipped.width = Math.max(0, Math.min(hostBox.right, rect.left + rect.width) - clipped.left);
      clipped.height = Math.max(0, Math.min(hostBox.bottom, rect.top + rect.height) - clipped.top);
      if (clipped.width <= 0 || clipped.height <= 0) return;
      overlays.push(clipped);
    };

    // The toolbar and the readout row float over the viewport-sized canvas; the
    // last in-flow chrome row's bottom edge is the band they cover (the panel
    // measures exactly this as `topObscuredPx`).
    let topBand = 0;
    for (const element of panel.querySelectorAll<HTMLElement>(sel.toolbar + ',' + sel.header)) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      topBand = Math.max(topBand, Math.ceil(rect.bottom - hostBox.top));
    }
    if (topBand > 0) {
      overlays.push({
        left: hostBox.left,
        top: hostBox.top,
        right: hostBox.right,
        bottom: hostBox.top + Math.min(hostBox.height, topBand),
        width: hostBox.width,
        height: Math.min(hostBox.height, topBand),
      });
    }
    // The corner slot (minimap + zoom cluster) and the selection tray are
    // absolute surfaces over the canvas, inset from the edges.
    for (const element of [
      ...panel.querySelectorAll<HTMLElement>(sel.overlays + ' > *'),
      ...panel.querySelectorAll<HTMLElement>(sel.tray),
      // The provenance footer is in flow at the bottom of the overlay.
      ...panel.querySelectorAll<HTMLElement>(sel.footer),
    ]) {
      addOverlay(element.getBoundingClientRect());
    }
    const hostLocal = overlays.map((overlay) => ({
      left: overlay.left - hostBox.left,
      top: overlay.top - hostBox.top,
      width: overlay.width,
      height: overlay.height,
    }));
    const available = availableFitArea({ width: hostBox.width, height: hostBox.height }, hostLocal);

    const svg = host.querySelector('svg');
    const svgRect = svg?.getBoundingClientRect() ?? null;
    const viewBox = (svg?.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
    const viewBoxWidth = viewBox.length === 4 && viewBox.every(Number.isFinite) ? viewBox[2] : 0;
    const svgScale = svgRect !== null && viewBoxWidth > 0 ? svgRect.width / viewBoxWidth : 1;
    let minFontPx = Number.POSITIVE_INFINITY;
    for (const text of svg?.querySelectorAll('text') ?? []) {
      const element = text as SVGTextElement;
      if (element.getClientRects().length === 0) continue;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const font = Number.parseFloat(style.fontSize);
      if (!Number.isFinite(font) || font <= 0) continue;
      minFontPx = Math.min(minFontPx, font * svgScale);
    }
    const drawing = svgRect === null ? null : boxOf(svgRect);
    const fill = drawing === null || available.width <= 0 || available.height <= 0
      ? 0
      : Math.max(drawing.width / available.width, drawing.height / available.height);

    return {
      host: hostBox,
      drawing,
      // Only the overlays that intersect the host are part of the answer.
      overlays: hostLocal.map((overlay) => ({
        left: overlay.left,
        top: overlay.top,
        right: overlay.left + overlay.width,
        bottom: overlay.top + overlay.height,
        width: overlay.width,
        height: overlay.height,
      })),
      available: {
        left: available.left,
        top: available.top,
        right: available.left + available.width,
        bottom: available.top + available.height,
        width: available.width,
        height: available.height,
      },
      fill,
      minFontPx: Number.isFinite(minFontPx) ? minFontPx : 0,
      appViewport: root?.getAttribute('data-architecture-fit-viewport') ?? null,
      tier: svg?.getAttribute('data-architecture-semantic') ?? null,
      scale: Number(svg?.getAttribute('data-architecture-semantic-scale')),
      overflowX: host.scrollWidth - host.clientWidth,
      overflowY: host.scrollHeight - host.clientHeight,
    };
  }, SEL);
}

function formatReading(label: string, reading: FullscreenFitReading): string {
  return `${label} host=${reading.host.width.toFixed(1)}x${reading.host.height.toFixed(1)} `
    + `available=${reading.available.width.toFixed(1)}x${reading.available.height.toFixed(1)} `
    + `drawing=${reading.drawing === null ? 'none' : `${reading.drawing.width.toFixed(1)}x${reading.drawing.height.toFixed(1)}`} `
    + `fill=${(reading.fill * 100).toFixed(1)}% tier=${reading.tier} scale=${reading.scale} `
    + `appViewport=${reading.appViewport} minFont=${reading.minFontPx.toFixed(2)} `
    + `overlays=${reading.overlays.map((overlay) => `${overlay.width.toFixed(0)}x${overlay.height.toFixed(0)}@${overlay.left.toFixed(0)},${overlay.top.toFixed(0)}`).join(' ')} `
    + `overflow=${reading.overflowX}x${reading.overflowY}`;
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
}

/** The `WxH` the product publishes, or null when it published nothing usable. */
function parseViewport(value: string | null): { width: number; height: number } | null {
  const parts = (value ?? '').split('x').map(Number);
  return parts.length === 2 && parts.every(Number.isFinite)
    ? { width: parts[0], height: parts[1] }
    : null;
}

/**
 * The assertion set BOTH arms are judged by. The control arm keeps the lever
 * on, so it also calls this and must fail the fill/containment reading; the
 * arm itself asserts that it did.
 */
function expectFittedReading(label: string, reading: FullscreenFitReading, floorPx: number): void {
  console.log(`[fullscreen-fit] ${formatReading(label, reading)}`);
  expect(reading.overlays.length, `${label}: the overlay's chrome must be measured`).toBeGreaterThan(0);
  expect(reading.drawing, `${label}: the drawing exists`).not.toBeNull();
  expect(reading.minFontPx, `${label}: effective screen font`).toBeGreaterThanOrEqual(floorPx - 1e-6);
  // The app's own Fit box IS the measured area (same arithmetic, one frame),
  // one pixel smaller for the semantic writer's `Math.ceil` rounding.
  const solved = parseViewport(reading.appViewport);
  expect(solved, `${label}: the product published its Fit box`).not.toBeNull();
  expect(
    Math.abs((solved as { width: number }).width - reading.available.width),
    `${label}: the product solved against the measured chrome (width)`,
  ).toBeLessThanOrEqual(FIT_TOLERANCE_PX);
  expect(
    Math.abs((solved as { height: number }).height - reading.available.height),
    `${label}: the product solved against the measured chrome (height)`,
  ).toBeLessThanOrEqual(FIT_TOLERANCE_PX);
  expect(reading.fill, `${label}: the drawing fills the measured area's limiting dimension`).toBeGreaterThanOrEqual(
    MIN_FILL_RATIO - 1e-6,
  );
  const drawing = reading.drawing as Box;
  // The chrome never paints over the drawing.
  for (const overlay of reading.overlays) {
    expect(
      overlaps(drawing, overlay),
      `${label}: the drawing must not run under an overlay at ${overlay.left},${overlay.top}`,
    ).toBe(false);
  }
  // And a drawing that is inside the area must be inside it exactly.
  if (reading.fill <= 1.05) {
    expect(drawing.left, `${label}: inside the area (left)`).toBeGreaterThanOrEqual(reading.available.left + reading.host.left - FIT_TOLERANCE_PX);
    expect(drawing.right, `${label}: inside the area (right)`).toBeLessThanOrEqual(reading.available.right + reading.host.left + FIT_TOLERANCE_PX);
    expect(drawing.top, `${label}: inside the area (top)`).toBeGreaterThanOrEqual(reading.available.top + reading.host.top - FIT_TOLERANCE_PX);
    expect(drawing.bottom, `${label}: inside the area (bottom)`).toBeLessThanOrEqual(reading.available.bottom + reading.host.top + FIT_TOLERANCE_PX);
  }
}

/* ── page driving ───────────────────────────────────────────────────────────────────────── */

function contextFor(browser: Browser, viewport: (typeof VIEWPORTS)[number]): Promise<BrowserContext> {
  return (async () => {
    const dataDir = process.env.QUAY_E2E_DATA_DIR;
    if (!dataDir) throw new Error('playwright.config.ts must publish QUAY_E2E_DATA_DIR');
    warmClientPromise ??= warmClientStartup(baseURL, dataDir);
    await warmClientPromise;
    return browser.newContext({
      baseURL,
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.touch,
      isMobile: viewport.touch,
    });
  })();
}

async function openSession(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  attachEvidence(page);
  await page.addInitScript((authToken: string) => {
    window.localStorage.setItem('auth-token', authToken);
    window.localStorage.setItem('userLanguage', 'en');
  }, token);
  await page.goto(`/session/${sessionId}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  try {
    await page.waitForFunction(
      () => [...document.querySelectorAll('[data-workspace-tab]')].some((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      }),
      undefined,
      { timeout: 60_000 },
    );
  } catch (error) {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS_DIR, 'mount-fail.png') });
    await awaitClientMounted(page, '[data-workspace-tab]', 1_000, startupEvidence);
    throw error;
  }
  return page;
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await page.waitForTimeout(ms);
}

async function enterArchitecture(page: Page): Promise<void> {
  const direct = page.locator('[role="tab"][data-workspace-tab="architecture"]').first();
  if (await direct.count() === 0) {
    await page.locator('[aria-haspopup="dialog"][data-workspace-tab]').first().click();
    const inDialog = page.locator('[role="dialog"] [data-workspace-tab="architecture"]').first();
    await expect(inDialog).toBeVisible({ timeout: 15_000 });
    await inDialog.click();
  } else {
    await expect(direct).toBeVisible({ timeout: 30_000 });
    await direct.click();
  }
  await expect(page.locator(`[data-workspace-view="architecture"] ${SEL.panel}`)).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    ({ root, host, node }) => Number(document.querySelector(root)?.getAttribute('data-architecture-visible-nodes') ?? '0') > 0
      && (document.querySelector(host)?.querySelectorAll(node).length ?? 0) > 0,
    { root: SEL.graphRoot, host: SEL.host, node: SEL.node },
    { timeout: 60_000 },
  );
  await settle(page, 800);
}

async function enterFullscreen(page: Page, viewport: (typeof VIEWPORTS)[number]): Promise<void> {
  // Every compact (touch) tier keeps the Fullscreen door inside the Adjust
  // sheet; the desktop row carries it directly.
  if (viewport.touch) {
    await page.locator(SEL.sheetToggle).first().click({ timeout: 10_000 });
    await expect(page.locator(SEL.sheet)).toBeVisible({ timeout: 10_000 });
  }
  // Put the drawing in the sticky `auto` state first: on the compact tiers the
  // Fit control is behind the sheet / a collapsed cluster, and the overlay's
  // own re-fit is what solves the fullscreen area. The desktop tier also
  // presses Fit again below, inside the overlay.
  const fitBefore = page.locator(`${SEL.zoomFit}:visible`).first();
  if (await fitBefore.count() > 0) {
    await fitBefore.click({ timeout: 5_000 }).catch(() => {
      // The compact cluster may expose the button only after it expands; the
      // overlay re-fit covers this path.
    });
  }
  await page.locator(`${SEL.fullscreenToggle}:visible`).first().click({ timeout: 15_000 });
  await expect(page.locator(SEL.fullscreenPanel)).toHaveCount(1, { timeout: 10_000 });
  await settle(page, 700);
  // The sheet can stay open over the drawing after the toggle; close it so it
  // is not one of the measured surfaces and cannot intercept the Fit press.
  if (await page.locator(SEL.sheetClose).count() > 0) {
    await page.locator(SEL.sheetClose).first().click({ timeout: 10_000 });
    await expect(page.locator(SEL.sheet)).toHaveCount(0, { timeout: 10_000 });
    await settle(page, 400);
  }
  if (!viewport.touch) {
    // The explicit Fit the criterion reads: the overlay already re-fitted, and
    // this press re-solves through the same path.
    await page.locator(`${SEL.zoomFit}:visible`).first().click({ timeout: 15_000 });
    await settle(page, 700);
  }
  // Whatever the tier hid the press behind, the drawing must be in Fit mode
  // before the reading is taken.
  await expect(page.locator(SEL.graphRoot).first()).toHaveAttribute('data-architecture-fit', 'auto', { timeout: 10_000 });
}

async function exitFullscreen(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.locator(SEL.fullscreenPanel)).toHaveCount(0, { timeout: 10_000 });
  await settle(page, 400);
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
}

/* ── the main arm ───────────────────────────────────────────────────────────────────────── */

for (const viewport of VIEWPORTS) {
  test(`main arm — ${viewport.name}: the L drawing fills the fullscreen area minus measured chrome`, async ({ browser }) => {
    const context = await contextFor(browser, viewport);
    try {
      const page = await openSession(context);
      try {
        await enterArchitecture(page);
        await enterFullscreen(page, viewport);
        const reading = await readFullscreenFit(page);
        expectFittedReading(`${viewport.name}.fullscreen`, reading, viewport.touch ? PHONE_FLOOR_PX : PC_FLOOR_PX);
        await shot(page, `${viewport.name}-fullscreen-fit`);
        console.log(`[fullscreen-fit] ${viewport.name} wall clock: ${Date.now() - RUN_STARTED_AT}ms`);

        await exitFullscreen(page);
        // Leaving the overlay restores the in-flow fit; the reading is taken
        // again so a regression there cannot hide behind the overlay's.
        const restored = await readFullscreenFit(page);
        console.log(`[fullscreen-fit] ${formatReading(`${viewport.name}.restored`, restored)}`);
        expect(restored.appViewport, `${viewport.name}: the in-flow reading is restored`).not.toBeNull();
      } finally {
        await page.close();
      }
    } finally {
      await context.close();
    }
  });
}

/* ── the control arm ───────────────────────────────────────────────────────────────────── */

test('control arm — reserved non-fullscreen margins red the same fill reading, and removing the lever greens it', async ({ browser }) => {
  const viewport = VIEWPORTS[0];
  const context = await contextFor(browser, viewport);
  try {
    const page = await openSession(context);
    try {
      await enterArchitecture(page);
      // The DEV-only lever the shipped path never reads: Fit keeps the
      // non-fullscreen canvas after the overlay makes the host the viewport.
      await page.evaluate(() => window.localStorage.setItem('architecture-fullscreen-fit-margins', 'reserved'));
      await enterFullscreen(page, viewport);

      // The SAME reader as the main arm. The defect is read raw (not through
      // `expectFittedReading`, which would throw before the arm could state
      // its own claim): the retired rule fits the non-fullscreen canvas, so the
      // drawn share of the MEASURED area is below the floor.
      const defect = await readFullscreenFit(page);
      console.log(`[fullscreen-fit] ${formatReading(`${viewport.name}.control`, defect)}`);
      expect(defect.drawing, 'control: the drawing exists').not.toBeNull();
      expect(defect.minFontPx, 'control: the floor font still holds').toBeGreaterThanOrEqual(PC_FLOOR_PX - 1e-6);
      expect(defect.overlays.length, 'control: the chrome is measured in both arms').toBeGreaterThan(0);
      expect(
        defect.fill,
        `[fullscreen-fit] control: the reserved margin must red the fill reading; ${formatReading('control', defect)}`,
      ).toBeLessThan(MIN_FILL_RATIO);
      // ...and the product really solved against the retired box, not the
      // measured area (that is what the main arm's appViewport assertion pins).
      const retired = parseViewport(defect.appViewport);
      expect(retired, 'control: the product published its Fit box').not.toBeNull();
      expect(
        Math.abs((retired as { width: number }).width - defect.available.width) <= FIT_TOLERANCE_PX
          && Math.abs((retired as { height: number }).height - defect.available.height) <= FIT_TOLERANCE_PX,
        'control: Fit used the retired non-fullscreen box, not the measured area',
      ).toBe(false);
      await shot(page, `${viewport.name}-control-reserved-margins`);

      // Removing the lever returns the same reading to green in the same page.
      // The overlay is left and re-entered so its chrome is re-measured: the
      // lever is a DEV seam, and a production reader never turns it off under
      // a live overlay.
      await page.evaluate(() => window.localStorage.removeItem('architecture-fullscreen-fit-margins'));
      await exitFullscreen(page);
      await enterFullscreen(page, viewport);
      const repaired = await readFullscreenFit(page);
      expectFittedReading(`${viewport.name}.control-repaired`, repaired, PC_FLOOR_PX);
      await shot(page, `${viewport.name}-control-repaired`);
    } finally {
      await page.close();
    }
  } finally {
    await context.close();
  }
});
