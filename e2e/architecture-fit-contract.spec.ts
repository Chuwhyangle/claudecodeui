import fs from 'node:fs';
import path from 'node:path';

import { expect, request, test } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';

import {
  FIT_CONTRACT_WORKSPACES,
  writeFitContractFixture,
  type FitContractFixtureOptions,
  type FitContractFixtureReading,
} from './support/architectureFixture';
import { awaitClientMounted, warmClientStartup, type RequestFailure } from './support/client-startup-warmup';

/**
 * The architecture canvas's single-scale / fit contract, in a real browser.
 *
 * WHAT IT PROVES. The semantic engine owns the ONLY proportion (`s`, baked into
 * the geometry and shown 1:1) and Fit solves that scale against the canvas;
 * the drawing stays sticky-fitted across window resizes, fullscreen and the
 * inspector; and the floor font never drops below 10 px (PC) / 11 px (phone).
 *
 * THE MATRIX. Four fixtures — S (2 entities), M (26), L (55) and a Quay-shaped
 * 19-interface drawing — on four viewports (1440×765, 1920×900, 390×844,
 * 844×390), reading the same state five times: after load, after Fit, after a
 * window resize, after entering/leaving fullscreen, and after opening/closing
 * the Inspector.
 *
 * THE READING. One `evaluate` per state, because the claim is a RELATION
 * between boxes that must be read on one frame: the drawing's screen box
 * against its host, the effective screen font (SVG font × the box's own
 * scale), the one scale both the readout and the SVG state, and the host's
 * scroll overflow. Every control arm re-reads through the SAME function.
 */

const RUN_STARTED_AT = Number(process.env.QUAY_E2E_RUN_STARTED_AT) || Date.now();

// One case drives four fixtures through six canvas states each; the config's
// 60 s per-test default bounds a single such reading, not the whole viewport.
test.describe.configure({ timeout: 180_000 });

const USERNAME = 'architecture-fit-contract-e2e';
const PASSWORD = 'architecture-fit-contract-e2e-pass';

/** The four viewports the contract is stated on. */
const VIEWPORTS = [
  { name: 'pc-1440x765', width: 1440, height: 765, touch: false },
  { name: 'pc-1920x900', width: 1920, height: 900, touch: false },
  { name: 'phone-390x844', width: 390, height: 844, touch: true },
  { name: 'phone-844x390', width: 844, height: 390, touch: true },
] as const;

/** The four fixture shapes, smallest first. */
const FIXTURES = [
  {
    key: 's',
    options: { entityCount: 2, entityKind: 'class', packageCount: 1, labelStem: 'FitS' } satisfies FitContractFixtureOptions,
  },
  {
    key: 'm',
    options: { entityCount: 26, entityKind: 'class', packageCount: 3, labelStem: 'FitM' } satisfies FitContractFixtureOptions,
  },
  {
    key: 'l',
    options: { entityCount: 55, entityKind: 'class', packageCount: 5, labelStem: 'FitL' } satisfies FitContractFixtureOptions,
  },
  {
    key: 'quay',
    // The Quay OO shape: 19 interfaces, short names, a few shallow packages —
    // wide enough to be the case the old 69 % focus default overflowed, but
    // not so many package tabs that the PACKAGE tier itself cannot fit.
    options: {
      entityCount: 19,
      entityKind: 'interface',
      packageCount: 4,
      labelStem: 'QuayIface',
    } satisfies FitContractFixtureOptions,
  },
] as const;

/** The smallest screen font the canvas may draw. */
const PC_FLOOR_PX = 10;
const PHONE_FLOOR_PX = 11;

/** How far a fitted drawing may stray from its host (the renderer rounds up). */
const FIT_TOLERANCE_PX = 2;

const SHOTS_DIR = path.resolve(process.cwd(), 'tmp', 'architecture-fit-contract');

const SEL = {
  panel: '[data-architecture-panel]',
  graphRoot: '[data-architecture-plantuml-graph]',
  host: '[data-architecture-plantuml]',
  zoomFit: '[data-architecture-zoom-fit]',
  zoomIn: '[data-architecture-zoom-in]',
  zoomLevel: '[data-architecture-zoom-level]',
  zoomClusterLevel: '[data-architecture-zoom-cluster-level]',
  fullscreenToggle: '[data-architecture-fullscreen-toggle]',
  sheetToggle: '[data-architecture-sheet-toggle]',
  sheet: '[data-architecture-sheet]',
  sheetClose: '[data-architecture-sheet-close]',
  fullscreenOverlay: '[data-architecture-panel][data-architecture-fullscreen="true"]',
  inspector: '[data-architecture-inspector]',
  dockClose: '[data-architecture-dock-close]',
  node: '.uml-node[data-entity-id]',
} as const;

/* ── the fixture + session setup ─────────────────────────────────────────────────────────── */

const readings = new Map<string, FitContractFixtureReading>();
const sessionIds = new Map<string, string>();

let baseURL = '';

const startupEvidence = {
  pageErrors: [] as string[],
  consoleErrors: [] as string[],
  requestFailures: [] as RequestFailure[],
  warmup: null as null,
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
    seed: { title: 'Architecture fit contract', userText: `Review ${mentioned} before the refactor.` },
    steps: [{ at: 0, op: 'wait' }],
    expect: { rows: { delta: 0 }, content: { mustContain: [seedIdentifiers[0] ?? ''] } },
  };
  const response = await api.post('/api/debug-agent/scenarios', { data: { projectPath, scenario } });
  const body = await response.json().catch(() => null);
  if (!response.ok()) throw new Error(`arming failed (${response.status()}): ${JSON.stringify(body)}`);
  const sessionId = body?.data?.sessionId;
  if (typeof sessionId !== 'string') throw new Error(`arming returned no sessionId: ${JSON.stringify(body)}`);
  return sessionId;
}

let token = '';
let warmClientPromise: Promise<unknown> | null = null;

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
    for (const fixture of FIXTURES) {
      const workspace = path.join(fixtureHome, FIT_CONTRACT_WORKSPACES[fixture.key]);
      const reading = writeFitContractFixture(workspace, fixture.options);
      readings.set(fixture.key, reading);
      sessionIds.set(fixture.key, await armScenario(api, workspace, reading.seedIdentifiers));
      console.log(`[architecture-fit] fixture=${fixture.key} entities=${reading.entityTotal} session=${sessionIds.get(fixture.key)}`);
    }
  } finally {
    await api.dispose();
  }
});

/* ── reading the canvas ──────────────────────────────────────────────────────────────────── */

type FitState = {
  readonly fit: string | null;
  readonly zoomMode: string | null;
  readonly zoomScale: number;
  readonly semanticScale: number;
  readonly readout: string;
  readonly viewBoxWidth: number;
  readonly svgWidth: number;
  readonly svgHeight: number;
  readonly host: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  readonly drawing: { left: number; top: number; right: number; bottom: number; width: number; height: number } | null;
  readonly overflowX: number;
  readonly overflowY: number;
  readonly minFontPx: number;
  readonly minFontDetail: string;
  readonly coarsePointer: boolean;
  readonly focusControls: number;
  readonly folded: string | null;
  readonly tier: string | null;
};

/** One round trip: every reading below is taken from the SAME frame. */
async function readFitState(page: Page): Promise<FitState> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel.graphRoot);
    const host = document.querySelector<HTMLElement>(sel.host);
    const svg = host?.querySelector('svg') ?? null;
    const hostRect = host?.getBoundingClientRect();
    const svgRect = svg?.getBoundingClientRect() ?? null;
    const viewBox = (svg?.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
    const viewBoxWidth = viewBox.length === 4 && viewBox.every(Number.isFinite) ? viewBox[2] : 0;
    // The effective screen font: the painted size × the box's own scale. This
    // is the reading a CSS factor on the mapped SVG changes, which is what the
    // control arm exploits.
    const svgScale = svgRect !== null && viewBoxWidth > 0 ? svgRect.width / viewBoxWidth : 1;
    let minFontPx = Number.POSITIVE_INFINITY;
    let minFontDetail = 'none';
    for (const text of svg?.querySelectorAll('text') ?? []) {
      const element = text as SVGTextElement;
      if (element.getClientRects().length === 0) continue;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const font = Number.parseFloat(style.fontSize);
      if (!Number.isFinite(font) || font <= 0) continue;
      const effective = font * svgScale;
      if (effective < minFontPx) {
        minFontPx = effective;
        const chain: string[] = [];
        let ancestor: Element | null = element;
        for (let depth = 0; depth < 4 && ancestor !== null; depth += 1) {
          chain.push(`${ancestor.tagName.toLowerCase()}.${ancestor.getAttribute('class') ?? ''}`);
          ancestor = ancestor.parentElement;
        }
        minFontDetail = `${font}px "${(element.textContent ?? '').slice(0, 24)}" path=${chain.join('<')}`;
      }
    }
    return {
      fit: root?.getAttribute('data-architecture-fit') ?? null,
      zoomMode: root?.getAttribute('data-architecture-zoom-mode') ?? null,
      zoomScale: Number(root?.getAttribute('data-architecture-zoom-scale')),
      semanticScale: Number(svg?.getAttribute('data-architecture-semantic-scale')),
      // The compact tier draws the tier row inside the Adjust sheet, but the
      // on-canvas zoom cluster always states the same percentage.
      readout: (document.querySelector(sel.zoomLevel)
        ?? document.querySelector(sel.zoomClusterLevel))?.textContent?.trim() ?? '',
      viewBoxWidth,
      svgWidth: Number(svg?.getAttribute('width')),
      svgHeight: Number(svg?.getAttribute('height')),
      host: hostRect === undefined ? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } : {
        left: hostRect.left,
        top: hostRect.top,
        right: hostRect.right,
        bottom: hostRect.bottom,
        width: hostRect.width,
        height: hostRect.height,
      },
      drawing: svgRect === null ? null : {
        left: svgRect.left,
        top: svgRect.top,
        right: svgRect.right,
        bottom: svgRect.bottom,
        width: svgRect.width,
        height: svgRect.height,
      },
      overflowX: host === null ? 0 : host.scrollWidth - host.clientWidth,
      overflowY: host === null ? 0 : host.scrollHeight - host.clientHeight,
      minFontPx: Number.isFinite(minFontPx) ? minFontPx : 0,
      minFontDetail,
      coarsePointer: window.matchMedia('(pointer: coarse)').matches,
      focusControls: document.querySelectorAll(
        '[data-architecture-readable-focus-mode], [data-architecture-readable-overview-mode], '
          + '[data-architecture-readable-toggle], [data-architecture-canvas-readable-toggle]',
      ).length,
      folded: root?.getAttribute('data-architecture-fold-depth') ?? null,
      tier: svg?.getAttribute('data-architecture-semantic') ?? null,
    };
  }, SEL);
}

function formatState(label: string, state: FitState): string {
  return `${label} fit=${state.fit} coarse=${state.coarsePointer} readout=${state.readout} zoom=${state.zoomScale} `
    + `semantic=${state.semanticScale} tier=${state.tier} folded=${state.folded} `
    + `minFont=${state.minFontPx.toFixed(2)}(${state.minFontDetail}) overflow=${state.overflowX}x${state.overflowY} `
    + `host=${state.host.width.toFixed(1)}x${state.host.height.toFixed(1)} `
    + `drawing=${state.drawing === null ? 'none' : `${state.drawing.width.toFixed(1)}x${state.drawing.height.toFixed(1)}`}`;
}

/** A folded map at the floor scale is allowed to scroll; everything else must fit. */
function scrollTolerated(state: FitState): boolean {
  return state.folded !== null && state.semanticScale <= 0.0500001;
}

/** The assertion set every state (main and control arm) is judged by. */
function expectFitted(label: string, state: FitState, expectAuto = true, expectContained = true): void {
  console.log(`[architecture-fit] ${formatState(label, state)}`);
  if (expectAuto) expect(state.fit, `${label}: the canvas keeps the sticky fit state`).toBe('auto');
  expect(state.focusControls, `${label}: no Focus / Overview control may exist`).toBe(0);
  expect(state.minFontPx, `${label}: effective screen font`).toBeGreaterThanOrEqual(
    (state.coarsePointer ? PHONE_FLOOR_PX : PC_FLOOR_PX) - 1e-6,
  );
  expect(state.readout, `${label}: the readout states the ONE semantic percentage`)
    .toBe(`${Math.round(state.semanticScale * 100)}%`);
  expect(state.zoomScale, `${label}: root scale and SVG semantic scale are one value`)
    .toBeCloseTo(state.semanticScale, 6);
  // k = 1: the mapped SVG is shown at its own viewBox size. A CSS factor would
  // make the two differ (the retired defect printed 74 % for a 17 % map).
  expect(state.svgWidth, `${label}: k = 1 (width)`).toBeCloseTo(state.viewBoxWidth, 1);
  if (!expectContained || scrollTolerated(state)) return;
  expect(state.drawing, `${label}: the drawing exists`).not.toBeNull();
  const drawing = state.drawing as NonNullable<FitState['drawing']>;
  expect(drawing.left, `${label}: drawing left inside the host`).toBeGreaterThanOrEqual(state.host.left - FIT_TOLERANCE_PX);
  expect(drawing.right, `${label}: drawing right inside the host`).toBeLessThanOrEqual(state.host.right + FIT_TOLERANCE_PX);
  expect(drawing.top, `${label}: drawing top inside the host`).toBeGreaterThanOrEqual(state.host.top - FIT_TOLERANCE_PX);
  expect(drawing.bottom, `${label}: drawing bottom inside the host`).toBeLessThanOrEqual(state.host.bottom + FIT_TOLERANCE_PX);
  expect(state.overflowX, `${label}: no horizontal scroll overflow`).toBeLessThanOrEqual(FIT_TOLERANCE_PX);
  expect(state.overflowY, `${label}: no vertical scroll overflow`).toBeLessThanOrEqual(FIT_TOLERANCE_PX);
}

/* ── page driving ───────────────────────────────────────────────────────────────────────── */

function contextFor(browser: Browser, viewport: (typeof VIEWPORTS)[number]): Promise<BrowserContext> {
  return (async () => {
    const dataDir = process.env.QUAY_E2E_DATA_DIR;
    if (!dataDir) throw new Error('playwright.config.ts must publish QUAY_E2E_DATA_DIR');
    warmClientPromise ??= warmClientStartup(baseURL, dataDir);
    // Pay the dependency-optimizer warm-up before the first document: a cold
    // optimizer makes the mount race the startup budget on the short viewport.
    await warmClientPromise;
    return browser.newContext({
      baseURL,
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.touch,
      isMobile: viewport.touch,
    });
  })();
}

async function openSession(context: BrowserContext, fixtureKey: string): Promise<Page> {
  const page = await context.newPage();
  attachEvidence(page);
  await page.addInitScript((authToken: string) => {
    window.localStorage.setItem('auth-token', authToken);
    window.localStorage.setItem('userLanguage', 'en');
  }, token);
  const sessionId = sessionIds.get(fixtureKey);
  if (sessionId === undefined) throw new Error(`no session for fixture ${fixtureKey}`);
  await page.goto(`/session/${sessionId}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  // The phone tier puts the workspace tabs behind an overflow dialog, so the
  // mount wait is the generic tab marker and `enterArchitecture` opens the
  // dialog when the direct tab is not drawn.
  try {
    // A page-side visibility probe: on the compact tier the CLOSED picker
    // dialog's rows are also mounted, and a selector-based `visible` wait can
    // latch onto the wrong match. This reads the boxes that actually render.
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
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS_DIR, `mount-fail-${fixtureKey}.png`) });
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
    // The compact tier keeps its tabs in an overflow dialog.
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
    { timeout: 40_000 },
  );
  await settle(page, 600);
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
}

/* ── the main arm ───────────────────────────────────────────────────────────────────────── */

for (const viewport of VIEWPORTS) {
  test(`main arm — ${viewport.name}: every fixture stays fitted across load, Fit, resize, fullscreen and Inspector`, async ({ browser }) => {
    const context = await contextFor(browser, viewport);
    try {
      for (const fixture of FIXTURES) {
        const label = `${fixture.key}@${viewport.name}`;
        const page = await openSession(context, fixture.key);
        try {
          await enterArchitecture(page);
          expectFitted(`${label}.load`, await readFitState(page));
          await shot(page, `${label}-01-load`);

          // Fit re-solves explicitly.
          await page.locator(`${SEL.zoomFit}:visible`).first().click({ timeout: 15_000 });
          await settle(page, 350);
          expectFitted(`${label}.fit`, await readFitState(page));
          await shot(page, `${label}-02-fit`);

          // A real canvas size change must re-solve after the 150 ms debounce.
          // The SHORT landscape phone cannot take a resize of the emulated
          // device metrics (Playwright's mobile emulation rejects it), so that
          // one tier collapses the sidebar: the canvas box changes exactly the
          // same way. The portrait phone and both desktops resize the window.
          if (viewport.touch && viewport.height <= 400) {
            await page.locator('button[title="Hide sidebar"]').first().click({ timeout: 10_000 });
            await settle(page, 500);
            expectFitted(`${label}.resize`, await readFitState(page));
            await shot(page, `${label}-03-resize`);
            console.log(`[architecture-fit] ${label} resize read done`);
            await page.locator('button[aria-label="Show sidebar"]').first().click({ timeout: 10_000 });
            await settle(page, 500);
            console.log(`[architecture-fit] ${label} sidebar restored`);
          } else {
            const narrowed = Math.max(280, viewport.width - 140);
            await page.setViewportSize({ width: narrowed, height: viewport.height });
            await settle(page, 500);
            expectFitted(`${label}.resize`, await readFitState(page));
            await shot(page, `${label}-03-resize`);
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await settle(page, 500);
          }

          console.log(`[architecture-fit] ${label} entering fullscreen`);
          // Fullscreen: entering and leaving the overlay are canvas changes.
          // On the short landscape phone the control lives in the Adjust sheet.
          if (viewport.touch && viewport.height <= 400) {
            await page.locator(SEL.sheetToggle).first().click({ timeout: 10_000 });
            await expect(page.locator(SEL.sheet)).toBeVisible({ timeout: 10_000 });
          }
          await page.locator(`${SEL.fullscreenToggle}:visible`).first().click({ timeout: 15_000 });
          await expect(page.locator(SEL.fullscreenOverlay)).toHaveCount(1, { timeout: 10_000 });
          console.log(`[architecture-fit] ${label} fullscreen open`);
          await settle(page, 500);
          expectFitted(`${label}.fullscreen`, await readFitState(page));
          await shot(page, `${label}-04-fullscreen`);
          await page.keyboard.press('Escape');
          await expect(page.locator(SEL.fullscreenOverlay)).toHaveCount(0, { timeout: 10_000 });
          await settle(page, 500);
          expectFitted(`${label}.fullscreen-exit`, await readFitState(page));

          // The short tier reached fullscreen through the Adjust sheet; close
          // it so its scrim cannot intercept the selection below.
          if (await page.locator(SEL.sheetClose).count() > 0) {
            await page.locator(SEL.sheetClose).first().click({ timeout: 10_000 });
            await expect(page.locator(SEL.sheet)).toHaveCount(0, { timeout: 10_000 });
            await settle(page, 300);
          }

          // Inspector: opening and closing it changes the canvas width / the
          // coarse drawer's reserved band. At the package-only tiers no entity
          // is drawn, so a package is tapped first — the retained "tap a
          // package" gesture — which is an EXPLICIT zoom (`manual`).
          let manualForInspector = false;
          if (await page.locator(`${SEL.node}:visible`).count() === 0) {
            manualForInspector = true;
            // A package-only tier draws no entity to select. Zoom in explicitly
            // (the same explicit-zoom path a reader uses) until the richer
            // tier puts boxes on screen.
            for (let step = 0; step < 8; step += 1) {
              await page.locator(`${SEL.zoomIn}:visible`).first().click({ timeout: 10_000 });
              await settle(page, 150);
              if (await page.locator(`${SEL.node}:visible`).count() > 0) break;
            }
            await expect(
              page.locator(`${SEL.node}:visible`).first(),
              `${label}: an explicit zoom must expose a selectable entity`,
            ).toBeVisible({ timeout: 10_000 });
            await settle(page, 400);
          }
          const node = page.locator(`${SEL.node}:visible`).first();
          await node.click({ timeout: 15_000 });
          await expect(page.locator(SEL.inspector)).toBeVisible({ timeout: 15_000 });
          await settle(page, 500);
          expectFitted(`${label}.inspector`, await readFitState(page), !manualForInspector, !manualForInspector);
          await shot(page, `${label}-05-inspector`);
          await page.locator(`${SEL.dockClose}:visible`).first().click({ timeout: 15_000 });
          await expect(page.locator(SEL.inspector)).toHaveCount(0, { timeout: 15_000 });
          await settle(page, 500);
          expectFitted(`${label}.inspector-closed`, await readFitState(page), !manualForInspector, !manualForInspector);
          if (manualForInspector) {
            // The explicit package zoom is over; Fit proves `auto` is still
            // reachable from a manual state after the inspector round trip.
            await page.locator(`${SEL.zoomFit}:visible`).first().click({ timeout: 15_000 });
            await settle(page, 400);
            expectFitted(`${label}.inspector-fit-restored`, await readFitState(page));
          }
        } finally {
          await page.close();
        }
      }
    } finally {
      await context.close();
    }
    console.log(`[architecture-fit] ${viewport.name} wall clock: ${Date.now() - RUN_STARTED_AT}ms`);
  });
}

/* ── the control arms ───────────────────────────────────────────────────────────────────── */

/**
 * Every arm reproduces one shipped defect in the SAME page and re-reads it
 * through the SAME function: the CSS factor the fit used to apply, the resize
 * re-solve turned off, and the retired "unreadable fit opens focused" rule.
 */
test('control arm — a CSS fit factor reds the floor font, an off switch reds the resize, a focus default reds the fit', async ({ browser }) => {
  const viewport = VIEWPORTS[0];
  const context = await contextFor(browser, viewport);
  try {
    // ── arm 1: a CSS factor on the already-mapped drawing ────────────────────
    const factorPage = await openSession(context, 'm');
    await enterArchitecture(factorPage);
    const greenFactor = await readFitState(factorPage);
    expectFitted('control.factor.green', greenFactor);
    await factorPage.evaluate(() => {
      const svg = document.querySelector('[data-architecture-plantuml] svg');
      if (svg instanceof SVGElement) svg.style.transform = 'scale(0.55)';
    });
    await settle(factorPage, 250);
    const redFactor = await readFitState(factorPage);
    console.log(`[architecture-fit] ${formatState('control.factor.red', redFactor)}`);
    expect(redFactor.minFontPx, 'the CSS factor must push the floor font under the limit').toBeLessThan(PC_FLOOR_PX);
    await factorPage.evaluate(() => {
      const svg = document.querySelector('[data-architecture-plantuml] svg');
      if (svg instanceof SVGElement) svg.style.transform = '';
    });
    await settle(factorPage, 250);
    expectFitted('control.factor.restored', await readFitState(factorPage));
    await factorPage.close();

    // ── arm 2: the auto re-solve switched off ────────────────────────────────
    const resizePage = await openSession(context, 'l');
    await enterArchitecture(resizePage);
    await resizePage.evaluate(() => window.localStorage.setItem('architecture-auto-fit', 'off'));
    // A 100 px narrowing is below the 15 % aspect-relayout threshold, so the
    // drawing is NOT re-laid out; only the disabled auto re-solve would notice
    // it. The stale fit therefore genuinely overflows.
    await resizePage.setViewportSize({ width: viewport.width - 100, height: viewport.height });
    await settle(resizePage, 600);
    const redResize = await readFitState(resizePage);
    console.log(`[architecture-fit] ${formatState('control.resize.red', redResize)}`);
    expect(
      redResize.overflowX > FIT_TOLERANCE_PX || redResize.overflowY > FIT_TOLERANCE_PX,
      'without the re-solve, the stale fit must overflow the narrowed canvas',
    ).toBe(true);
    await resizePage.evaluate(() => window.localStorage.removeItem('architecture-auto-fit'));
    await resizePage.setViewportSize({ width: viewport.width, height: viewport.height });
    await settle(resizePage, 600);
    // The resize back also drives the re-solve that was switched off before.
    await resizePage.setViewportSize({ width: viewport.width - 140, height: viewport.height });
    await settle(resizePage, 600);
    expectFitted('control.resize.green', await readFitState(resizePage));
    await resizePage.close();

    // ── arm 3: the retired focus default, on the Quay fixture ────────────────
    const focusPage = await openSession(context, 'quay');
    await enterArchitecture(focusPage);
    await focusPage.evaluate(() => window.localStorage.setItem('architecture-default-focus', 'on'));
    await focusPage.locator(SEL.zoomFit).first().click();
    await settle(focusPage, 400);
    const redFocus = await readFitState(focusPage);
    console.log(`[architecture-fit] ${formatState('control.focus.red', redFocus)}`);
    expect(
      redFocus.overflowX > FIT_TOLERANCE_PX || redFocus.overflowY > FIT_TOLERANCE_PX
        || (redFocus.drawing !== null
          && (redFocus.drawing.right > redFocus.host.right + FIT_TOLERANCE_PX
            || redFocus.drawing.bottom > redFocus.host.bottom + FIT_TOLERANCE_PX)),
      'the focused default must leave the Quay drawing outside its host',
    ).toBe(true);
    await focusPage.evaluate(() => window.localStorage.removeItem('architecture-default-focus'));
    await focusPage.locator(SEL.zoomFit).first().click();
    await settle(focusPage, 400);
    expectFitted('control.focus.green', await readFitState(focusPage));
    await focusPage.close();

    expect(startupEvidence.pageErrors, 'no page errors during the control arms').toEqual([]);
  } finally {
    await context.close();
  }
  console.log(`[architecture-fit] control arm wall clock: ${Date.now() - RUN_STARTED_AT}ms`);
});
