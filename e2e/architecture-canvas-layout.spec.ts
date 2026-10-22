import path from 'node:path';

import { expect, request, test } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';

import {
  ARCHITECTURE_FIXTURE_WORKSPACE,
  writeArchitectureFixture,
  type ArchitectureFixtureReading,
} from './support/architectureFixture';
import {
  awaitClientMounted,
  warmClientStartup,
  type RequestFailure,
} from './support/client-startup-warmup';

/**
 * The architecture tab, measured in a real browser.
 *
 * WHY THIS FILE EXISTS. Every other architecture criterion runs in jsdom, and
 * jsdom has no layout engine: it can read an inline `style.minHeight` but never
 * a box. Three layout defects shipped through that gap — the canvas collapsing
 * to its content height inside a taller panel, the readout row drawn over the
 * drawing's first row, and a readout whose N did not name the entities the
 * drawing showed. This spec is the missing layer: a real Chromium against the
 * real server and client, reading `getBoundingClientRect` from the panel that
 * is actually on screen.
 *
 * WHAT IT READS (all from one `evaluate` per state, because the question is a
 * relation between boxes and two boxes measured a frame apart can invent an
 * overlap that never existed):
 *
 *  1. canvas fill — the drawing host's height against the panel height the
 *     in-flow chrome above it leaves free;
 *  2. overlay clearance — the readout row's bottom edge against the top of the
 *     drawing, and the minimap / zoom cluster against every drawn node;
 *  3. readout agreement — N (the summary attribute) against the entities the
 *     layout actually drew (the renderer's own `data-architecture-visible-nodes`
 *     reading), plus N ≤ M and at most one budget sentence in the collapsed row;
 *  4. touch targets — every architecture button at least 44×44 on the phone
 *     viewport (WCAG 2.5.5, the same number `useTouchLayout.ts` applies).
 *
 * THE TWO CONTROL ARMS. A guard that only ever reports "good" proves nothing.
 * Each arm reproduces one of the shipped defects by injecting a style into the
 * SAME page, re-reads the SAME geometry through the SAME function, and asserts
 * the reading lands on the failing side; the injected style is then removed and
 * the same function asserted back on the passing side. The reads differ only in
 * the injected style — the arm's own state (zoom, scroll) is identical on both
 * sides of the injection.
 *
 * THE FIXTURE. `e2e/support/architectureFixture.ts` writes a 120-entity
 * `.archguard` tree into the run's debug-agent fixture home before the scenario
 * is armed, and the seeded user text names the five seed entities so the
 * server's seed extractor resolves them. No binary fixture is committed. The
 * directory families are kept few on purpose: the overview folds entities into
 * one box per directory, which is what decides the drawing's size, and the
 * chrome-clearance reading needs the whole drawing on screen at once (a
 * drawing that fills a 390 px phone canvas runs under the corner chrome — the
 * panel's corner-avoiding fit models a left-aligned drawing, the canvas centres
 * it — so the criterion measures the whole-graph state the fit is for, and the
 * entity count is read on the explosion view where all 120 boxes are drawn).
 */

/**
 * The instant this invocation began, published by `playwright.config.ts`.
 *
 * The 55 s ceiling is on the WHOLE invocation — config evaluation, both servers'
 * boot, browser launch, seeding — so a spec that timed only its own body would
 * report a number whose shortfall against the ceiling is the part it cannot see.
 * The fallback can only make the reading smaller, never larger.
 */
const RUN_STARTED_AT = Number(process.env.QUAY_E2E_RUN_STARTED_AT) || Date.now();

/** The two viewports the criterion runs: the PC panel and the phone panel. */
const VIEWPORT_PC = { width: 1440, height: 765 };
const VIEWPORT_PHONE = { width: 390, height: 844 };

/**
 * How much of the panel's free height the drawing host must occupy.
 *
 * The task fixes this at 95%. The shipped defect left the host at 342 px inside
 * a 669 px region — ~51% — so the threshold is not a hair's breadth away from
 * the failure it exists to catch.
 */
const CANVAS_FILL_RATIO = 0.95;

/**
 * The smallest hit area a control may have on the phone viewport, in CSS pixels.
 *
 * WCAG 2.5.5 and the value `TOUCH_TARGET_STYLE` writes inline, so the browser
 * reading and the stylesheet's statement are the same number.
 */
const TOUCH_TARGET_PX = 44;

/** The account this run owns; distinct from every sibling spec's. */
const USERNAME = 'architecture-layout-e2e';
const PASSWORD = 'architecture-layout-e2e-pass';

/** The tab the reading is taken on, and the elements it reads. */
const SEL = {
  panel: '[data-architecture-panel]',
  toolbar: '[data-architecture-toolbar]',
  touchHint: '[data-architecture-touch-hint]',
  canvas: '[data-architecture-canvas]',
  canvasRegionHeader: '[data-architecture-canvas-header]',
  graphRoot: '[data-architecture-plantuml-graph]',
  host: '[data-architecture-plantuml]',
  readout: '[data-architecture-readout]',
  readoutSummary: '[data-architecture-readout-summary]',
  readoutTotal: '[data-architecture-readout-total]',
  minimap: '[data-architecture-minimap]',
  zoomCluster: '[data-architecture-zoom-cluster]',
  node: '.uml-node',
  zoomIn: '[data-architecture-zoom-in]',
  overviewMode: '[data-architecture-readable-overview-mode]',
  explosion: '[data-architecture-explosion]',
} as const;

/* ── the server's own faces ────────────────────────────────────────────────────────────────── */

/**
 * An account this run owns, created over the API.
 *
 * Register-then-login rather than register: a re-run against a data directory
 * that already holds this account must sign in, not fail. The onboarding call
 * is the wizard's last screen, which is what sets the profile flag the app
 * checks before it will show a workspace.
 */
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

/**
 * Arm the one scenario this file measures, and return the session id it was
 * indexed under.
 *
 * The scenario seeds the session's rows and nothing else: no clock walk is
 * armed, because a session's own user text is the whole transcript the
 * architecture service reads for seeds. The text names the fixture's seven seed
 * entities in backticks so the extractor's exact-match rule resolves them.
 */
async function armScenario(
  api: APIRequestContext,
  projectPath: string,
  userText: string,
  mustContain: string,
): Promise<string> {
  const scenario = {
    version: 1,
    dialect: 'claude',
    home: 'gate',
    transcript: { mode: 'per-row-jsonl' },
    seed: { title: 'Architecture canvas layout', userText },
    // The scenario contract demands at least one step, and this criterion never
    // walks the clock: the seeded user text is the whole transcript the
    // architecture service reads. `wait` writes nothing and carries nothing.
    steps: [{ at: 0, op: 'wait' }],
    expect: { rows: { delta: 0 }, content: { mustContain: [mustContain] } },
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

/* ── the page's own reading ───────────────────────────────────────────────────────────────── */

type Box = { x: number; y: number; w: number; h: number; x2: number; y2: number };

/** Everything one state of the panel reports, taken in a single round trip. */
type LayoutReading = {
  viewport: { width: number; height: number };
  /** The panel's own box. */
  panel: Box | null;
  /** The drawing host (`[data-architecture-plantuml]`). */
  host: Box | null;
  /** Height the panel leaves below its in-flow chrome — the space the drawing is given. */
  availableHeight: number | null;
  /** Host height ÷ available height. Reading 1. */
  fillRatio: number | null;
  /** The readout row: the panel's canvas header, or the readout itself on older builds. */
  readoutRow: Box | null;
  readout: Box | null;
  /** The drawing's first row as the canvas shows it: the SVG's box, clipped to the host. */
  drawingTop: number | null;
  /** The topmost drawn node box, reported beside `drawingTop` so a red names both. */
  firstNodeTop: number | null;
  /** The SVG's own box, before clipping. */
  svg: Box | null;
  /** Drawn node boxes (non-zero area), for the overlay-clearance relation. */
  nodeCount: number;
  /** Nodes overlapping the minimap or the zoom cluster. Empty on a healthy drawing. */
  chromeOverNodes: number;
  /** Those nodes' boxes, so a red names what it caught. */
  chromeOverNodeBoxes: Box[];
  minimapOverZoomCluster: boolean;
  minimap: Box | null;
  zoomCluster: Box | null;
  /** N — the entities the readout says the layout was handed. */
  readoutSummary: number | null;
  /** M — the readout's related count. */
  readoutTotal: number | null;
  /** The renderer's own count of the boxes it drew. */
  drawnNodes: number | null;
  /** How many times the collapsed row says "budget". Two is the shipped regression. */
  readoutBudgetWords: number;
  /** The collapsed row's text, so a red can be read against what it said. */
  readoutText: string;
  /** The scale/mode the drawing was fitted at, reported so a red says which state it read. */
  zoomMode: string;
  zoomScale: number | null;
  readableMode: string;
};

/**
 * Read the panel's geometry in ONE round trip.
 *
 * `availableHeight` is the panel's bottom edge minus the bottom of the last
 * IN-FLOW chrome row above the canvas (toolbar, the touch instruction, and — on
 * this build — the canvas header the readout lives in). Rows taken out of flow
 * by a control arm's own injection are excluded, so the reading keeps measuring
 * the panel rather than the defect being injected.
 *
 * `drawingTop` is the first row the canvas can show: the SVG's box, clipped to
 * the host's content top. A drawing shorter than its host is vertically
 * centred, but it still starts below the host's top edge; a drawing taller than
 * its host is scrolled, and its visible first row is the host's content top.
 * Either way this is the top of what the user sees, which is what the readout
 * row must not be drawn over.
 */
const readLayout = (page: Page): Promise<LayoutReading> =>
  page.evaluate((sel) => {
    const boxOf = (element: Element | null): Box | null => {
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, x2: rect.right, y2: rect.bottom };
    };
    const overlaps = (a: Box | null, b: Box | null): boolean =>
      Boolean(a && b && a.x < b.x2 && b.x < a.x2 && a.y < b.y2 && b.y < a.y2);
    const isInFlow = (element: Element): boolean => {
      const position = window.getComputedStyle(element).position;
      return position !== 'absolute' && position !== 'fixed';
    };
    const numberOf = (element: Element | null, attribute: string): number | null => {
      const raw = element?.getAttribute(attribute) ?? null;
      if (raw === null) return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    };

    const panel = document.querySelector(sel.panel);
    const toolbar = document.querySelector(sel.toolbar);
    const touchHint = document.querySelector(sel.touchHint);
    const canvasHeader = document.querySelector(sel.canvasRegionHeader);
    const canvas = document.querySelector(sel.canvas);
    const host = document.querySelector(sel.host);
    const graphRoot = document.querySelector(sel.graphRoot);
    const readout = document.querySelector(sel.readout);
    // The row the readout is drawn in. This build states it as the canvas
    // header; a build without that row reads the readout's own box instead, so
    // the same function works against the commit the defect was measured on.
    const readoutRow = canvasHeader ?? readout;

    const panelBox = boxOf(panel);
    const canvasBox = boxOf(canvas);
    const hostBox = boxOf(host);
    const readoutRowBox = boxOf(readoutRow);
    const svg = host?.querySelector('svg') ?? null;
    const svgBox = boxOf(svg);

    // The in-flow chrome above the canvas; the available height is what is left
    // below the lowest of those rows.
    const chrome = [toolbar, touchHint, canvasHeader]
      .filter((element): element is Element => element !== null)
      .filter(isInFlow)
      .map(boxOf)
      .filter((box): box is Box => box !== null)
      .filter((box) => canvasBox === null || box.y2 <= canvasBox.y + 1);
    const chromeBottom = chrome.length > 0 ? Math.max(...chrome.map((box) => box.y2)) : null;
    const availableHeight = panelBox !== null && chromeBottom !== null
      ? Math.max(0, panelBox.y2 - chromeBottom)
      : null;

    const hostPaddingTop = host === null
      ? 0
      : Number.parseFloat(window.getComputedStyle(host).paddingTop) || 0;
    const drawingTop = hostBox !== null && svgBox !== null
      ? Math.max(hostBox.y + hostPaddingTop, svgBox.y)
      : null;

    const nodeBoxes = [...document.querySelectorAll(sel.node)]
      .map(boxOf)
      .filter((box): box is Box => box !== null && box.w > 0 && box.h > 0);
    const minimapBox = boxOf(document.querySelector(sel.minimap));
    const zoomClusterBox = boxOf(document.querySelector(sel.zoomCluster));
    const chromeOverNodeBoxes = nodeBoxes.filter(
      (box) => overlaps(box, minimapBox) || overlaps(box, zoomClusterBox),
    );
    const chromeOverNodes = chromeOverNodeBoxes.length;

    const readoutText = (readout?.innerText ?? '').replace(/\s+/g, ' ').trim();

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      panel: panelBox,
      host: hostBox,
      availableHeight,
      fillRatio: hostBox !== null && availableHeight !== null && availableHeight > 0
        ? hostBox.h / availableHeight
        : null,
      readoutRow: readoutRowBox,
      readout: boxOf(readout),
      drawingTop,
      firstNodeTop: nodeBoxes.length > 0 ? Math.min(...nodeBoxes.map((box) => box.y)) : null,
      svg: svgBox,
      nodeCount: nodeBoxes.length,
      chromeOverNodes,
      chromeOverNodeBoxes,
      minimapOverZoomCluster: overlaps(minimapBox, zoomClusterBox),
      minimap: minimapBox,
      zoomCluster: zoomClusterBox,
      readoutSummary: numberOf(document.querySelector(sel.readoutSummary), 'data-architecture-readout-summary'),
      readoutTotal: numberOf(document.querySelector(sel.readoutTotal), 'data-architecture-readout-total'),
      drawnNodes: numberOf(graphRoot, 'data-architecture-visible-nodes'),
      readoutBudgetWords: (readoutText.match(/budget/gi) ?? []).length,
      readoutText,
      zoomMode: graphRoot?.getAttribute('data-architecture-zoom-mode') ?? '<none>',
      zoomScale: numberOf(graphRoot, 'data-architecture-zoom-scale'),
      readableMode: graphRoot?.getAttribute('data-architecture-readable-mode') ?? '<none>',
    };
  }, SEL);

/** A box as the criterion prints it: `x,y,w,h`, rounded, or a named absence. */
const formatBox = (box: Box | null): string =>
  box ? `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.w)},${Math.round(box.h)}` : '<none>';

/** A number as the criterion prints it, rounded to three decimals, or a named absence. */
const formatNumber = (value: number | null): string =>
  value === null ? '<none>' : String(Math.round(value * 1000) / 1000);

/** Print one state's whole reading, so every assertion below is readable against it. */
const printReading = (label: string, reading: LayoutReading): void => {
  console.log(`[architecture-layout] ${label}.viewport=${reading.viewport.width}x${reading.viewport.height}`);
  console.log(`[architecture-layout] ${label}.panel.box=${formatBox(reading.panel)}`);
  console.log(`[architecture-layout] ${label}.canvas.host.box=${formatBox(reading.host)}`);
  console.log(`[architecture-layout] ${label}.canvas.available.height=${formatNumber(reading.availableHeight)}`);
  console.log(`[architecture-layout] ${label}.canvas.fill.ratio=${formatNumber(reading.fillRatio)}`);
  console.log(`[architecture-layout] ${label}.readout.row.box=${formatBox(reading.readoutRow)}`);
  console.log(`[architecture-layout] ${label}.readout.box=${formatBox(reading.readout)}`);
  console.log(`[architecture-layout] ${label}.svg.box=${formatBox(reading.svg)}`);
  console.log(`[architecture-layout] ${label}.drawing.top=${formatNumber(reading.drawingTop)}`);
  console.log(`[architecture-layout] ${label}.first.node.top=${formatNumber(reading.firstNodeTop)}`);
  console.log(`[architecture-layout] ${label}.nodes.drawn=${reading.nodeCount}`);
  console.log(`[architecture-layout] ${label}.chrome.over.nodes=${reading.chromeOverNodes}`);
  console.log(`[architecture-layout] ${label}.chrome.over.node.boxes=${JSON.stringify(reading.chromeOverNodeBoxes.map(formatBox))}`);
  console.log(`[architecture-layout] ${label}.minimap.box=${formatBox(reading.minimap)}`);
  console.log(`[architecture-layout] ${label}.zoomCluster.box=${formatBox(reading.zoomCluster)}`);
  console.log(`[architecture-layout] ${label}.minimap.over.zoomCluster=${reading.minimapOverZoomCluster}`);
  console.log(`[architecture-layout] ${label}.readout.N=${formatNumber(reading.readoutSummary)}`);
  console.log(`[architecture-layout] ${label}.readout.M=${formatNumber(reading.readoutTotal)}`);
  console.log(`[architecture-layout] ${label}.layout.entity.count=${formatNumber(reading.drawnNodes)}`);
  console.log(`[architecture-layout] ${label}.readout.budget.words=${reading.readoutBudgetWords}`);
  console.log(`[architecture-layout] ${label}.readout.text=${JSON.stringify(reading.readoutText)}`);
  console.log(`[architecture-layout] ${label}.zoom=${reading.zoomMode}@${formatNumber(reading.zoomScale)} readable=${reading.readableMode}`);
};

/* ── the guard's own legs ─────────────────────────────────────────────────────────────────── */

/**
 * Reading 1: the drawing host fills the height the panel leaves it.
 *
 * Soft assertions on purpose: on the defective commit this leg and reading 2
 * are both expected to red, and a throwing assertion would hide the second
 * reading's numbers — which are the evidence that leg exists to produce.
 */
const assertCanvasFilled = (reading: LayoutReading, label: string): void => {
  expect.soft(
    reading.host,
    `${label}: the drawing host must exist; panel=${formatBox(reading.panel)}`,
  ).not.toBeNull();
  expect.soft(
    reading.availableHeight,
    `${label}: the panel must report the height it leaves the drawing`,
  ).not.toBeNull();
  expect.soft(
    reading.fillRatio,
    `${label}: the canvas must fill the panel — host height ${formatNumber(reading.host?.h ?? null)}px `
      + `vs available ${formatNumber(reading.availableHeight)}px = ${formatNumber(reading.fillRatio)} `
      + `(threshold ${CANVAS_FILL_RATIO})`,
  ).not.toBeNull();
  expect.soft(
    reading.fillRatio ?? 0,
    `${label}: the canvas must fill the panel — host height ${formatNumber(reading.host?.h ?? null)}px `
      + `vs available ${formatNumber(reading.availableHeight)}px = ${formatNumber(reading.fillRatio)} `
      + `must be >= ${CANVAS_FILL_RATIO}; panel=${formatBox(reading.panel)} host=${formatBox(reading.host)}`,
  ).toBeGreaterThanOrEqual(CANVAS_FILL_RATIO);
};

/**
 * Reading 2a: the row the readout lives in must sit above the drawing's first row.
 *
 * The message carries both numbers the criterion is read by: the row's bottom
 * edge and the top of the first row the canvas draws.
 */
const assertReadoutAboveDrawing = (reading: LayoutReading, label: string): void => {
  expect.soft(
    reading.readoutRow,
    `${label}: the source must draw the readout this guard is about`,
  ).not.toBeNull();
  expect.soft(
    reading.drawingTop,
    `${label}: the drawing's first row must be measurable; svg=${formatBox(reading.svg)} host=${formatBox(reading.host)}`,
  ).not.toBeNull();
  expect.soft(
    (reading.readoutRow?.y2 ?? Number.POSITIVE_INFINITY) <= (reading.drawingTop ?? Number.NEGATIVE_INFINITY),
    `${label}: the readout row must not be drawn over the drawing — `
      + `readout row bottom ${formatNumber(reading.readoutRow?.y2 ?? null)} `
      + `vs SVG first row top ${formatNumber(reading.drawingTop)} `
      + `(readout row=${formatBox(reading.readoutRow)} first node top=${formatNumber(reading.firstNodeTop)} `
      + `svg=${formatBox(reading.svg)})`,
  ).toBe(true);
};

/**
 * Reading 2b: the floating corner chrome must not be drawn over a node.
 *
 * Only meaningful on a whole-graph fit — that is the state whose scale is
 * computed to clear the corners (`fitAvoidingCorners`). A focused or zoomed
 * drawing is deliberately larger than its viewport, so this leg is read on the
 * fitted state only.
 */
const assertChromeClearOfNodes = (reading: LayoutReading, label: string): void => {
  expect.soft(
    reading.nodeCount,
    `${label}: the drawing must have nodes to clear; the panel showed none`,
  ).toBeGreaterThan(0);
  expect.soft(
    reading.chromeOverNodes,
    `${label}: the minimap and the zoom cluster must not cover a drawn node — `
      + `${reading.chromeOverNodes} of ${reading.nodeCount} nodes overlap the corner chrome; `
      + `minimap=${formatBox(reading.minimap)} zoom cluster=${formatBox(reading.zoomCluster)}`,
  ).toBe(0);
  expect.soft(
    reading.minimapOverZoomCluster,
    `${label}: the minimap and the zoom cluster must not overlap each other; `
      + `minimap=${formatBox(reading.minimap)} zoom cluster=${formatBox(reading.zoomCluster)}`,
  ).toBe(false);
};

/**
 * Reading 3: the readout's N is the layout's own entity count, and M is not
 * smaller than it.
 *
 * `drawnNodes` is the renderer's `data-architecture-visible-nodes` reading —
 * the boxes it drew for this view. On the explosion view that count IS the
 * entity count (no directory groups are drawn there), which is what makes the
 * comparison meaningful rather than a box-count check that grouping could
 * satisfy by accident.
 */
const assertReadoutAgreesWithLayout = (reading: LayoutReading, label: string): void => {
  expect.soft(
    reading.readoutSummary,
    `${label}: the readout must publish N`,
  ).not.toBeNull();
  expect.soft(
    reading.drawnNodes,
    `${label}: the renderer must publish the number of entities it drew`,
  ).not.toBeNull();
  expect.soft(
    reading.readoutSummary === reading.drawnNodes,
    `${label}: the readout's N must equal the entities the layout drew — `
      + `N=${formatNumber(reading.readoutSummary)} drawn=${formatNumber(reading.drawnNodes)} `
      + `text=${JSON.stringify(reading.readoutText)}`,
  ).toBe(true);
  expect.soft(
    (reading.readoutSummary ?? Number.POSITIVE_INFINITY) <= (reading.readoutTotal ?? Number.NEGATIVE_INFINITY),
    `${label}: N must not exceed M — N=${formatNumber(reading.readoutSummary)} M=${formatNumber(reading.readoutTotal)}`,
  ).toBe(true);
  expect.soft(
    reading.readoutBudgetWords,
    `${label}: the collapsed row must not stack two budget sentences — `
      + `${reading.readoutBudgetWords} budget word(s) in ${JSON.stringify(reading.readoutText)}`,
  ).toBeLessThanOrEqual(1);
};

/* ── page setup ───────────────────────────────────────────────────────────────────────────── */

/** The startup evidence this file's pages collect; see `client-startup-warmup.ts`. */
const startupEvidence: {
  pageErrors: string[];
  consoleErrors: string[];
  requestFailures: RequestFailure[];
  warmup: null;
} = { pageErrors: [], consoleErrors: [], requestFailures: [], warmup: null };

/** The warm-up, taken exactly once per worker before any page exists. */
let warmClientPromise: Promise<unknown> | null = null;

/**
 * Open one signed-in page on the requested viewport.
 *
 * The warm-up runs before the first page of the run: the dependency optimizer
 * commits its bundle during the first document load and pushes a full reload,
 * and a criterion that lost that race would report a white page as a layout
 * red. The auth token and the UI language are seeded into `localStorage` before
 * the document runs, the same way the resident specs enter the app.
 */
async function openSignedInPage(
  browser: Browser,
  baseURL: string,
  token: string,
  form: { viewport: { width: number; height: number }; touch: boolean },
): Promise<{ context: BrowserContext; page: Page }> {
  const dataDir = process.env.QUAY_E2E_DATA_DIR;
  if (!dataDir) throw new Error('playwright.config.ts must publish QUAY_E2E_DATA_DIR');
  warmClientPromise ??= warmClientStartup(baseURL, dataDir);

  const context = await browser.newContext({
    baseURL,
    viewport: form.viewport,
    hasTouch: form.touch,
    isMobile: form.touch,
  });
  await context.addInitScript(
    ({ authKey, authToken, language }: { authKey: string; authToken: string; language: string }) => {
      window.localStorage.setItem(authKey, authToken);
      window.localStorage.setItem('userLanguage', language);
    },
    { authKey: 'auth-token', authToken: token, language: 'en' },
  );
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

/**
 * The landing signal: the Architecture tab itself, on either tier.
 *
 * Exactly one element matches on either tier — the desktop pill (`role="tab"`)
 * on a wide screen, the picker trigger on a phone — so the bounded mount probe
 * waits on a single element rather than on a selector that resolves to the
 * whole tab list. It also states the thing the reading needs: the project's
 * `.archguard` cache made the tab visible at all (Tier-1).
 */
const ARCHITECTURE_TAB_LANDING =
  '[role="tab"][data-workspace-tab="architecture"], [aria-haspopup="dialog"][data-workspace-tab]';

/**
 * Navigate to one session and open the architecture tab.
 *
 * The landing probe is the workspace tab bar, which exists on both tiers (a
 * pill on a wide screen, the picker trigger on a phone). The architecture tab is
 * then reached the way a reader reaches it: the pill on the desktop viewport,
 * the picker dialog on the phone one.
 */
async function openArchitectureTab(page: Page, sessionId: string): Promise<void> {
  // A simple bounded navigation, not the replay guard: this page's first load
  // pays this run's cold Vite module graph (measured here at ~4s), and a replay
  // that REPLACES the document resets that work rather than finishing it. The
  // mount wait is what carries the failure evidence, so a document that never
  // mounts still fails by name with the page's own text and the run's requests.
  try {
    await page.goto(`/session/${sessionId}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  } catch (error) {
    console.log(
      `[architecture-layout] navigation did not return in 20s (the mount probe decides): `
        + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    await awaitClientMounted(page, ARCHITECTURE_TAB_LANDING, 25_000, startupEvidence);
  } catch (error) {
    // A mount red already carries the page's text and the run's failed requests.
    // What it cannot say is *which* tab elements existed and how they were
    // laid out — so a red names the URL and the tab boxes it could see.
    const dump = await page.evaluate(() => ({
      url: window.location.href,
      tabs: [...document.querySelectorAll('[data-workspace-tab]')].map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          tab: element.getAttribute('data-workspace-tab'),
          w: rect.width,
          h: rect.height,
          display: window.getComputedStyle(element).display,
          visibility: window.getComputedStyle(element).visibility,
        };
      }),
      appShell: Boolean(document.querySelector('[data-app-shell]')),
    }));
    console.log(`[architecture-layout][diag] ${JSON.stringify(dump)}`);
    throw error;
  }

  const desktopTab = page.locator(`[role="tab"][data-workspace-tab="architecture"]`);
  if ((await desktopTab.count()) > 0 && (await desktopTab.first().isVisible())) {
    await desktopTab.first().click();
  } else {
    await page.locator('[aria-haspopup="dialog"][data-workspace-tab]').first().click();
    await page.locator('[role="dialog"] [data-workspace-tab="architecture"]').first().click();
  }

  await expect(
    page.locator('[data-workspace-view="architecture"] [data-architecture-panel]'),
    'the architecture tab must open for a project carrying an .archguard cache',
  ).toBeVisible({ timeout: 30_000 });
  await waitForDrawing(page);
}

/**
 * Wait until the drawing is on screen and has settled.
 *
 * The renderer lays out asynchronously (ELK on the main thread), then mounts the
 * minimap a frame later and re-fits once the corner chrome has a size. Reading
 * before that would measure the drawing the panel had a moment ago.
 */
async function waitForDrawing(page: Page): Promise<void> {
  await page.waitForFunction(
    (sel) => {
      const root = document.querySelector(sel.graphRoot);
      const host = document.querySelector(sel.host);
      const drawn = Number(root?.getAttribute('data-architecture-visible-nodes') ?? '0');
      return drawn > 0 && (host?.querySelectorAll(sel.node).length ?? 0) > 0;
    },
    SEL,
    { timeout: 40_000 },
  );
  await settle(page);
}

/** Two animation frames plus a beat: the fit, the minimap and its repaint all land inside it. */
async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await page.waitForTimeout(ms);
}

/**
 * The whole-graph view: the only state whose scale is computed to keep the
 * drawing clear of the corner chrome.
 */
async function showWholeGraph(page: Page): Promise<void> {
  const overview = page.locator(SEL.overviewMode);
  if ((await overview.count()) > 0 && (await overview.first().isVisible())) {
    await overview.first().click();
    await page.waitForFunction(
      (sel) => document.querySelector(sel.graphRoot)?.getAttribute('data-architecture-readable-mode') === 'overview',
      SEL,
      { timeout: 15_000 },
    );
  }
  await settle(page);
}

/**
 * Zoom the drawing past its canvas and leave the canvas scrolled to its top
 * edge, so the drawing's first row IS the canvas's first row.
 *
 * This is the state in which "is the readout drawn over the first row?" is a
 * real question for a drawing that would otherwise be centred in a taller
 * canvas. The state is identical on both sides of a control arm's injection.
 */
async function scrollDrawingToFirstRow(page: Page): Promise<void> {
  const zoomIn = page.locator(SEL.zoomIn);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const overflow = await page.evaluate((sel) => {
      const host = document.querySelector(sel.host);
      if (host === null) return false;
      return host.scrollHeight > host.clientHeight + 1 || host.scrollWidth > host.clientWidth + 1;
    }, SEL);
    if (overflow) break;
    await zoomIn.first().click();
    await page.waitForTimeout(120);
  }
  await page.evaluate((sel) => {
    const host = document.querySelector(sel.host);
    if (host === null) return;
    host.scrollTop = 0;
    host.scrollLeft = 0;
  }, SEL);
  await settle(page, 250);
}

/**
 * Switch the panel to the explosion view, where every entity is drawn as its
 * own box rather than folded into a directory group.
 *
 * Reading 3 compares N with the entities the layout DREW; on the grouped
 * overview that number is a box count, not an entity count, so the comparison
 * would be between two different quantities.
 */
async function showExplosionView(page: Page): Promise<void> {
  const explosion = page.locator(SEL.explosion);
  expect(await explosion.count(), 'the panel must offer the explosion view this reading draws').toBeGreaterThan(0);
  await explosion.first().click();
  await page.waitForFunction(
    (sel) => {
      const root = document.querySelector(sel.graphRoot);
      return root?.getAttribute('data-architecture-view') === 'hierarchy'
        && Number(root.getAttribute('data-architecture-visible-nodes') ?? '0') > 0;
    },
    SEL,
    { timeout: 30_000 },
  );
  await settle(page);
}

/* ── the fixture, built once per worker ──────────────────────────────────────────────────── */

let baseURL = '';
let sessionId = '';
let token = '';
let fixture: ArchitectureFixtureReading | null = null;

test.beforeAll(async () => {
  baseURL = test.info().project.use.baseURL ?? '';
  if (baseURL === '') throw new Error('playwright.config.ts must give this project a baseURL');

  const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
  if (!fixtureHome) {
    throw new Error(
      'playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME for this selection '
        + '(the architecture spec is listed in DEBUG_AGENT_SPEC_FILES)',
    );
  }

  const workspace = path.join(fixtureHome, ARCHITECTURE_FIXTURE_WORKSPACE);
  fixture = writeArchitectureFixture(workspace);

  const bootstrap = await request.newContext({ baseURL });
  token = await createAccount(bootstrap);
  await bootstrap.dispose();

  const api = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  // The seed entities, named in the session's own user text: the extractor's
  // rule is an EXACT match against the index's `nameToIds` keys, so a mention
  // that is not literally one of these names seeds nothing.
  const userText =
    'Please review the layout budget and the readout numbers. '
    + `Start at ${fixture.seedIdentifiers.map((name) => `\`${name}\``).join(', ')}.`;
  sessionId = await armScenario(api, workspace, userText, fixture.seedIdentifiers[0]);
  await api.dispose();

  console.log(`[architecture-layout] fixture.entities=${fixture.entityTotal}`);
  console.log(`[architecture-layout] fixture.workspace=${workspace}`);
  console.log(`[architecture-layout] session=${sessionId}`);
});

/* ── the main arm ────────────────────────────────────────────────────────────────────────── */

/**
 * The PC viewport: the drawing fills the panel, the chrome stays off it, and the
 * readout names what was drawn.
 */
test('main arm — the canvas fills the panel and the readout names the drawing (1440x765)', async ({ browser }) => {
  const { context, page } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PC,
    touch: false,
  });

  try {
    await openArchitectureTab(page, sessionId);
    await showWholeGraph(page);

    const fitted = await readLayout(page);
    printReading('pc.fitted', fitted);
    assertCanvasFilled(fitted, 'pc.fitted');
    assertReadoutAboveDrawing(fitted, 'pc.fitted');
    assertChromeClearOfNodes(fitted, 'pc.fitted');

    // Reading 3 is taken on the view that draws every entity as its own box.
    await showExplosionView(page);
    const explosion = await readLayout(page);
    printReading('pc.explosion', explosion);
    assertReadoutAgreesWithLayout(explosion, 'pc.explosion');

    const elapsed = Date.now() - RUN_STARTED_AT;
    console.log(`[architecture-layout] elapsed=${elapsed}ms`);
    expect.soft(
      elapsed,
      `the criterion has to end inside the single-file ceiling; measured ${elapsed}ms`,
    ).toBeLessThan(55_000);
  } finally {
    await context.close();
  }
});

/**
 * The phone viewport: the same geometry, plus the touch targets the phone tier
 * is required to offer (WCAG 2.5.5's 44×44).
 */
test('main arm — the phone canvas fills the panel and every control is a 44px target (390x844)', async ({ browser }) => {
  const { context, page } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PHONE,
    touch: true,
  });

  try {
    await openArchitectureTab(page, sessionId);
    await showWholeGraph(page);

    const fitted = await readLayout(page);
    printReading('phone.fitted', fitted);
    assertCanvasFilled(fitted, 'phone.fitted');
    assertReadoutAboveDrawing(fitted, 'phone.fitted');
    assertChromeClearOfNodes(fitted, 'phone.fitted');

    const controls = await page.evaluate((sel) => {
      const panel = document.querySelector(sel.panel);
      if (panel === null) return [];
      return [...panel.querySelectorAll('button')]
        .map((button) => {
          const rect = button.getBoundingClientRect();
          return {
            label: (button.textContent ?? button.getAttribute('aria-label') ?? '').trim().slice(0, 40),
            attribute: button.getAttributeNames().find((name) => name.startsWith('data-architecture-')) ?? '',
            w: rect.width,
            h: rect.height,
          };
        })
        .filter((control) => control.w > 0 && control.h > 0);
    }, SEL);
    console.log(`[architecture-layout] phone.controls=${JSON.stringify(controls)}`);
    expect(controls.length, 'the phone chrome must expose controls to measure').toBeGreaterThan(0);
    for (const control of controls) {
      expect.soft(
        Math.round(control.w) >= TOUCH_TARGET_PX && Math.round(control.h) >= TOUCH_TARGET_PX,
        `a phone control must be at least ${TOUCH_TARGET_PX}x${TOUCH_TARGET_PX}: `
          + `${JSON.stringify(control)}`,
      ).toBe(true);
    }

    await showExplosionView(page);
    const explosion = await readLayout(page);
    printReading('phone.explosion', explosion);
    assertReadoutAgreesWithLayout(explosion, 'phone.explosion');
  } finally {
    await context.close();
  }
});

/* ── the control arms (see the file header) ─────────────────────────────────────────────── */

/**
 * Control arm A: the shipped collapse, injected.
 *
 * `display: block` on the canvas region is exactly the defect the task was
 * filed against (`f7488b693`'s region was a block container), and it is applied
 * to the live panel so the SAME reading function sees both directions inside
 * one test: green before, red with the style, green again once it is removed.
 *
 * The whole-graph fit runs first so the drawing is a fitted one; a focused
 * drawing is deliberately taller than its canvas, which would keep the collapsed
 * content tall enough to look like a filled canvas by accident.
 */
test('control arm A — a block canvas region collapses the drawing below the panel', async ({ browser }) => {
  const { context, page } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PC,
    touch: false,
  });

  try {
    await openArchitectureTab(page, sessionId);
    await showWholeGraph(page);

    const before = await readLayout(page);
    printReading('controlA.before', before);
    assertCanvasFilled(before, 'controlA.before');

    const injected = await page.evaluate((sel) => {
      const panel = document.querySelector(sel.panel);
      const host = document.querySelector(sel.host);
      if (panel === null || host === null) return null;
      // The canvas region: the host's nearest ancestor that is a direct child of
      // the panel. Addressed structurally because the region carries no data
      // attribute (it is the layout container the defect was written into).
      let region: Element = host;
      while (region.parentElement !== null && region.parentElement !== panel) {
        region = region.parentElement;
      }
      const style = (region as HTMLElement).style;
      const previous = style.cssText;
      style.display = 'block';
      return {
        tag: region.tagName,
        className: typeof region.className === 'string' ? region.className : '',
        previous,
      };
    }, SEL);
    console.log(`[architecture-layout] controlA.injected=${JSON.stringify(injected)}`);
    expect(injected, 'the canvas region must be reachable from the host').not.toBeNull();
    await settle(page, 600);

    // `before` and `injected-reading` are the same function on the same page;
    // only the region's display differs.
    const collapsed = await readLayout(page);
    printReading('controlA.injected', collapsed);
    expect.soft(
      collapsed.fillRatio ?? Number.POSITIVE_INFINITY,
      `control arm A: a block canvas region must collapse the drawing — `
        + `host height ${formatNumber(collapsed.host?.h ?? null)}px `
        + `vs available ${formatNumber(collapsed.availableHeight)}px = ${formatNumber(collapsed.fillRatio)} `
        + `must be < ${CANVAS_FILL_RATIO}`,
    ).toBeLessThan(CANVAS_FILL_RATIO);

    await page.evaluate((sel) => {
      const panel = document.querySelector(sel.panel);
      const host = document.querySelector(sel.host);
      if (panel === null || host === null) return;
      let region: Element = host;
      while (region.parentElement !== null && region.parentElement !== panel) {
        region = region.parentElement;
      }
      (region as HTMLElement).style.display = '';
    }, SEL);
    await settle(page, 600);

    const restored = await readLayout(page);
    printReading('controlA.restored', restored);
    assertCanvasFilled(restored, 'controlA.restored');
  } finally {
    await context.close();
  }
});

/**
 * Control arm B: the shipped overlay, injected.
 *
 * The readout row is forced to `position: absolute; top: 12px` inside the
 * canvas region — the exact shape of `f7488b693`'s one-line reading, which sat
 * on the drawing's top-left corner and covered its first row. The canvas is
 * zoomed past its viewport and scrolled to the top first, so the drawing's first
 * row really is at the canvas's top edge on both sides of the injection; the
 * baseline reading in that same state must be green.
 */
test('control arm B — an absolute readout row covers the drawing’s first row', async ({ browser }) => {
  const { context, page } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PC,
    touch: false,
  });

  try {
    await openArchitectureTab(page, sessionId);
    await scrollDrawingToFirstRow(page);

    const before = await readLayout(page);
    printReading('controlB.before', before);
    assertReadoutAboveDrawing(before, 'controlB.before');

    const injected = await page.evaluate((sel) => {
      const row = document.querySelector(sel.canvasRegionHeader) ?? document.querySelector(sel.readout);
      if (!(row instanceof HTMLElement)) return null;
      const previous = row.style.cssText;
      row.style.position = 'absolute';
      row.style.top = '12px';
      row.style.left = '12px';
      row.style.right = 'auto';
      row.style.zIndex = '30';
      return { previous };
    }, SEL);
    console.log(`[architecture-layout] controlB.injected=${injected !== null}`);
    expect(injected, 'the readout row must be on screen').not.toBeNull();
    await settle(page, 500);

    const covered = await readLayout(page);
    printReading('controlB.injected', covered);
    expect.soft(
      (covered.readoutRow?.y2 ?? Number.NEGATIVE_INFINITY) > (covered.drawingTop ?? Number.POSITIVE_INFINITY),
      `control arm B: an absolute readout row must be read as covering the drawing — `
        + `readout row bottom ${formatNumber(covered.readoutRow?.y2 ?? null)} `
        + `vs SVG first row top ${formatNumber(covered.drawingTop)} `
        + `(readout row=${formatBox(covered.readoutRow)} first node top=${formatNumber(covered.firstNodeTop)})`,
    ).toBe(true);

    await page.evaluate((sel) => {
      const row = document.querySelector(sel.canvasRegionHeader) ?? document.querySelector(sel.readout);
      if (!(row instanceof HTMLElement)) return;
      row.style.cssText = '';
    }, SEL);
    await settle(page, 500);

    const restored = await readLayout(page);
    printReading('controlB.restored', restored);
    assertReadoutAboveDrawing(restored, 'controlB.restored');
  } finally {
    await context.close();
  }
});
