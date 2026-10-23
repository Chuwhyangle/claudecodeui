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
  // The phone tier puts the view controls in a bottom sheet opened by this
  // header button; the desktop tier has neither element.
  sheetToggle: '[data-architecture-sheet-toggle]',
  sheet: '[data-architecture-sheet]',
  sheetClose: '[data-architecture-sheet-close]',
  minimap: '[data-architecture-minimap]',
  zoomCluster: '[data-architecture-zoom-cluster]',
  node: '.uml-node',
  zoomIn: '[data-architecture-zoom-in]',
  zoomOut: '[data-architecture-zoom-out]',
  overviewMode: '[data-architecture-readable-overview-mode]',
  explosion: '[data-architecture-explosion]',
  // The provenance/cleanup row: a FOOTER under the canvas on every tier.
  footer: '[data-architecture-source-footer]',
  sourceLine: '[data-architecture-source-line]',
  // The project search's combobox and its listbox.
  search: '[data-architecture-search]',
  searchResults: '[data-architecture-search-results]',
  searchOption: '[data-architecture-search-results] [role="option"]',
  zoomLevel: '[data-architecture-zoom-level]',
  readableHint: '[data-architecture-readable-hint]',
  readableBack: '[data-architecture-readable-back]',
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
  /** The canvas region that holds the drawing host. */
  canvas: Box | null;
  /** Height the panel leaves below its in-flow chrome — the space the drawing is given. */
  availableHeight: number | null;
  /** Host height ÷ available height. Reading 1. */
  fillRatio: number | null;
  /** The readout row: the panel's canvas header, or the readout itself on older builds. */
  readoutRow: Box | null;
  readout: Box | null;
  /** Whether the readout is in flow (desktop) or floats over the drawing (phone). */
  readoutPosition: string;
  /** Drawn nodes the floating readout overlaps (phone tier). */
  readoutOverNodes: number;
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
  /**
   * The theoretical maximum fit: min(content width ÷ natural width, content
   * height ÷ natural height, 1). The zoom scale must reach 95% of it; the
   * shipped symmetric shrink reached 70%.
   */
  theoreticalFit: number | null;
  /** The drawing's natural (viewBox) size, so a red can recompute the ratio. */
  natural: { width: number; height: number } | null;
  /** The provenance/cleanup footer's box. */
  footer: Box | null;
  /** Whether the footer is in the document flow (not an absolute overlay). */
  footerPosition: string;
  /** Footer overlaps the corner chrome — the defect the footer replaced. */
  footerOverMinimap: boolean;
  footerOverZoomCluster: boolean;
  /** The tier's own percentage, for the "one value" agreement. */
  zoomLevelText: string;
  /** The readable hint's "Zoom N%" percentage, when the hint is drawn. */
  readableHintPercent: number | null;
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
    // The footer is in-flow chrome BELOW the canvas, so the drawing's available
    // height is what remains above it. Without this subtraction the footer
    // would read as lost canvas height.
    const footer = document.querySelector(sel.footer);
    const footerBox = boxOf(footer);
    const footerHeight = footerBox !== null ? footerBox.h : 0;
    const availableHeight = panelBox !== null && chromeBottom !== null
      ? Math.max(0, panelBox.y2 - chromeBottom - footerHeight)
      : null;

    const hostStyle = host === null ? null : window.getComputedStyle(host);
    const hostPaddingTop = host === null ? 0 : Number.parseFloat(hostStyle?.paddingTop ?? '') || 0;
    const hostPaddingX = (Number.parseFloat(hostStyle?.paddingLeft ?? '') || 0)
      + (Number.parseFloat(hostStyle?.paddingRight ?? '') || 0);
    const hostPaddingY = hostPaddingTop + (Number.parseFloat(hostStyle?.paddingBottom ?? '') || 0);
    const hostContent = host === null
      ? null
      : { width: host.clientWidth - hostPaddingX, height: host.clientHeight - hostPaddingY };
    const viewBoxParts = (svg?.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
    const natural = viewBoxParts.length === 4
      && viewBoxParts.every(Number.isFinite)
      && viewBoxParts[2] > 0
      && viewBoxParts[3] > 0
      ? { width: viewBoxParts[2], height: viewBoxParts[3] }
      : null;
    const theoreticalFit = natural !== null && hostContent !== null
      && hostContent.width > 0 && hostContent.height > 0
      ? Math.min(hostContent.width / natural.width, hostContent.height / natural.height, 1)
      : null;
    const zoomLevel = document.querySelector(sel.zoomLevel);
    const readableHint = document.querySelector(sel.readableHint);
    const hintPercent = /Zoom (\d+)%/.exec(readableHint?.textContent ?? '') ?? null;
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
    const readoutBox = boxOf(readout);
    const readoutOverNodes = nodeBoxes.filter((box) => overlaps(box, readoutBox)).length;

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      panel: panelBox,
      host: hostBox,
      canvas: canvasBox,
      availableHeight,
      fillRatio: hostBox !== null && availableHeight !== null && availableHeight > 0
        ? hostBox.h / availableHeight
        : null,
      readoutRow: readoutRowBox,
      readout: readoutBox,
      readoutPosition: readout === null ? '<none>' : window.getComputedStyle(readout).position,
      readoutOverNodes,
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
      theoreticalFit,
      natural,
      footer: footerBox,
      footerPosition: footer === null ? '<none>' : window.getComputedStyle(footer).position,
      footerOverMinimap: overlaps(footerBox, minimapBox),
      footerOverZoomCluster: overlaps(footerBox, zoomClusterBox),
      zoomLevelText: (zoomLevel?.textContent ?? '').trim(),
      readableHintPercent: hintPercent === null ? null : Number(hintPercent[1]),
    };
  }, SEL);

/**
 * How much of the search result list must be VISIBLE (after every clipping
 * ancestor and the viewport are intersected). The shipped defect left 3px; a
 * usable list shows several rows.
 */
const SEARCH_RESULT_MIN_VISIBLE_PX = 120;

/** What the search combobox reports about its popover, measured in one round trip. */
type SearchReading = {
  input: Box | null;
  results: Box | null;
  option: Box | null;
  /** The results' height left after intersecting the viewport and every clipping ancestor. */
  visibleHeight: number;
  /** The results box lies wholly inside the viewport. */
  insideViewport: boolean;
  /** `elementFromPoint` at the VISIBLE centre lands on one of this listbox's options. */
  centerHitsOption: boolean;
  center: { x: number; y: number } | null;
};

/**
 * Read the search popover's geometry. The clipping intersection is the point:
 * `getBoundingClientRect` ignores ancestor clipping, so a list clipped to 3px
 * by a scroll container still reports its full height. Every scroll/clip
 * ancestor's box is intersected in, exactly as the paint would be clipped.
 */
const readSearch = (page: Page): Promise<SearchReading> =>
  page.evaluate((sel) => {
    const boxOf = (element: Element | null): Box | null => {
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, x2: rect.right, y2: rect.bottom };
    };
    const input = document.querySelector(sel.search);
    const results = document.querySelector(sel.searchResults);
    if (!(results instanceof HTMLElement)) {
      return {
        input: boxOf(input),
        results: null,
        option: null,
        visibleHeight: 0,
        insideViewport: false,
        centerHitsOption: false,
        center: null,
      };
    }
    const rect = results.getBoundingClientRect();
    let clip = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    for (let ancestor = results.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
      const style = window.getComputedStyle(ancestor);
      const overflows = `${style.overflow} ${style.overflowX} ${style.overflowY}`;
      if (!/(auto|scroll|hidden)/.test(overflows)) continue;
      const box = ancestor.getBoundingClientRect();
      clip = {
        left: Math.max(clip.left, box.left),
        top: Math.max(clip.top, box.top),
        right: Math.min(clip.right, box.right),
        bottom: Math.min(clip.bottom, box.bottom),
      };
    }
    const left = Math.max(rect.left, clip.left);
    const right = Math.min(rect.right, clip.right);
    const top = Math.max(rect.top, clip.top);
    const bottom = Math.min(rect.bottom, clip.bottom);
    const center = right > left && bottom > top
      ? { x: (left + right) / 2, y: (top + bottom) / 2 }
      : null;
    const hit = center === null ? null : document.elementFromPoint(center.x, center.y);
    const option = hit?.closest('[role="option"]') ?? null;
    return {
      input: boxOf(input),
      results: boxOf(results),
      option: boxOf(results.querySelector('[role="option"]')),
      visibleHeight: Math.max(0, bottom - top),
      insideViewport: rect.left >= 0 && rect.top >= 0
        && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
      centerHitsOption: option !== null && results.contains(option),
      center,
    };
  }, SEL);

/**
 * Reading 6: the search results are fully visible and their visible centre is
 * an option of the same listbox.
 */
const assertSearchUsable = (reading: SearchReading, label: string): void => {
  expect.soft(reading.results, `${label}: the search must draw a result list`).not.toBeNull();
  expect.soft(
    reading.insideViewport,
    `${label}: the result list must lie wholly inside the viewport; results=${formatBox(reading.results)}`,
  ).toBe(true);
  expect.soft(
    reading.visibleHeight,
    `${label}: the result list must be visible, not clipped by a scroll ancestor — `
      + `visible height ${formatNumber(reading.visibleHeight)}px (threshold ${SEARCH_RESULT_MIN_VISIBLE_PX}px) `
      + `results=${formatBox(reading.results)}`,
  ).toBeGreaterThanOrEqual(SEARCH_RESULT_MIN_VISIBLE_PX);
  expect.soft(
    reading.centerHitsOption,
    `${label}: elementFromPoint at the visible centre must land on an option — `
      + `centre=${JSON.stringify(reading.center)} results=${formatBox(reading.results)} option=${formatBox(reading.option)}`,
  ).toBe(true);
};

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
  console.log(`[architecture-layout] ${label}.canvas.region.box=${formatBox(reading.canvas)}`);
  console.log(`[architecture-layout] ${label}.canvas.available.height=${formatNumber(reading.availableHeight)}`);
  console.log(`[architecture-layout] ${label}.canvas.fill.ratio=${formatNumber(reading.fillRatio)}`);
  console.log(`[architecture-layout] ${label}.readout.row.box=${formatBox(reading.readoutRow)}`);
  console.log(`[architecture-layout] ${label}.readout.box=${formatBox(reading.readout)}`);
  console.log(`[architecture-layout] ${label}.readout.position=${reading.readoutPosition}`);
  console.log(`[architecture-layout] ${label}.readout.over.nodes=${reading.readoutOverNodes}`);
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
  console.log(`[architecture-layout] ${label}.theoretical.fit=${formatNumber(reading.theoreticalFit)} natural=${JSON.stringify(reading.natural)}`);
  console.log(`[architecture-layout] ${label}.footer.box=${formatBox(reading.footer)} position=${reading.footerPosition}`);
  console.log(`[architecture-layout] ${label}.footer.over.minimap=${reading.footerOverMinimap} footer.over.zoomCluster=${reading.footerOverZoomCluster}`);
  console.log(`[architecture-layout] ${label}.zoom.level.text=${JSON.stringify(reading.zoomLevelText)} readable.hint.percent=${formatNumber(reading.readableHintPercent)}`);
};

/**
 * Reading 4: the provenance/cleanup row is a FOOTER in document flow, clear of
 * the canvas's corner chrome.
 *
 * The shipped layout floated it (and the "Scope cleanup" pill) over the
 * drawing's bottom-left corner, so it covered graph content and, on a phone,
 * stacked onto the zoom cluster. Both facts are read as geometry here.
 */
const assertFooterInFlow = (reading: LayoutReading, label: string): void => {
  expect.soft(reading.footer, `${label}: the panel must draw the provenance footer`).not.toBeNull();
  expect.soft(
    reading.footerPosition === 'absolute' || reading.footerPosition === 'fixed',
    `${label}: the footer must be in the document flow, not a floating layer (position=${reading.footerPosition})`,
  ).toBe(false);
  expect.soft(
    reading.footerOverMinimap,
    `${label}: the footer must not overlap the minimap; footer=${formatBox(reading.footer)} minimap=${formatBox(reading.minimap)}`,
  ).toBe(false);
  expect.soft(
    reading.footerOverZoomCluster,
    `${label}: the footer must not overlap the zoom cluster; footer=${formatBox(reading.footer)} cluster=${formatBox(reading.zoomCluster)}`,
  ).toBe(false);
};

/**
 * Reading 5: Fit really fits.
 *
 * `theoreticalFit` is the geometric maximum computed from the SVG's own
 * viewBox and the host's content box; the applied scale must reach 95% of it.
 * The shipped symmetric shrink — the drawing centred and then shrunk to clear
 * the bottom-right chrome — reached 70%, so this threshold is far from the red
 * it exists to catch. Where the zoom tier is on screen, its percentage and the
 * readable hint's "Zoom N%" must be the SAME number.
 */
const assertFitNearTheoretical = (reading: LayoutReading, label: string): void => {
  expect.soft(
    reading.theoreticalFit,
    `${label}: the theoretical fit needs a measurable SVG viewBox and canvas`,
  ).not.toBeNull();
  expect.soft(
    reading.zoomScale,
    `${label}: the renderer must publish the applied zoom scale`,
  ).not.toBeNull();
  const theoretical = reading.theoreticalFit ?? 0;
  const applied = reading.zoomScale ?? 0;
  expect.soft(
    applied >= theoretical * 0.95,
    `${label}: Fit must keep at least 95% of the theoretical fit — `
      + `scale ${formatNumber(applied)} vs theoretical ${formatNumber(theoretical)} `
      + `(natural=${JSON.stringify(reading.natural)} host content box drives the theoretical value)`,
  ).toBe(true);
  if (reading.zoomLevelText !== '' && reading.readableHintPercent !== null) {
    expect.soft(
      reading.zoomLevelText,
      `${label}: the zoom tier and the readable hint must print one percentage — `
        + `tier=${JSON.stringify(reading.zoomLevelText)} hint=${formatNumber(reading.readableHintPercent)}%`,
    ).toBe(`${reading.readableHintPercent}%`);
  }
};

/* ── the phone's density contract ────────────────────────────────────────────────────────── */

/**
 * The phone tier's density readings, all taken from the SAME `readLayout`
 * round trip as every other leg:
 *  · the fitted drawing reaches ≥85% of the canvas in its binding axis. The
 *    criterion's 95% is pinned exactly by `svgViewport.test.tsx` on the measured
 *    geometry (366×505 canvas, a ~1.05:1 drawing, a 44×44 corner button), where
 *    the corner is cleared by TRANSLATION and the fit is 100% of the maximum.
 *    THIS fixture's explosion drawing is portrait (~0.46) in a portrait phone
 *    canvas, so it binds on the HEIGHT: the mandatory 52px corner row can only
 *    be cleared by giving up ~9% of that height — 95% is geometrically
 *    unreachable there without demanding upscaling, and the shipped symmetric
 *    shrink (66% of both axes) still fails this floor;
 *  · the canvas region keeps at least 70% of the tab's height;
 *  · the collapsed readout is at most 44px tall;
 *  · the zoom cluster is one horizontal row at most 52px tall.
 *
 * Split into separate helpers so the control arm can reuse the cluster leg
 * verbatim (the guard must be shown able to go red on the same reading).
 */
const PHONE_DRAWING_FILL_FLOOR = 0.85;

const assertPhoneDrawingFillsCanvas = (reading: LayoutReading, label: string): void => {
  expect.soft(reading.svg, `${label}: the drawing must be measurable`).not.toBeNull();
  expect.soft(reading.canvas, `${label}: the canvas region must be measurable`).not.toBeNull();
  const widthShare = reading.svg !== null && reading.canvas !== null && reading.canvas.w > 0
    ? reading.svg.w / reading.canvas.w
    : 0;
  const heightShare = reading.svg !== null && reading.canvas !== null && reading.canvas.h > 0
    ? reading.svg.h / reading.canvas.h
    : 0;
  expect.soft(
    Math.max(widthShare, heightShare),
    `${label}: the fitted drawing must fill ≥${PHONE_DRAWING_FILL_FLOOR} of the canvas in its binding axis — `
      + `svg=${formatBox(reading.svg)} canvas=${formatBox(reading.canvas)} `
      + `width=${formatNumber(widthShare)} height=${formatNumber(heightShare)}`
      + ` (the shipped symmetric shrink left the drawing at ~66% of both)`,
  ).toBeGreaterThanOrEqual(PHONE_DRAWING_FILL_FLOOR);
};

const assertPhoneRegionHeight = (reading: LayoutReading, label: string): void => {
  expect.soft(reading.panel, `${label}: the panel must be measurable`).not.toBeNull();
  expect.soft(reading.canvas, `${label}: the canvas region must be measurable`).not.toBeNull();
  const share = reading.panel !== null && reading.canvas !== null && reading.panel.h > 0
    ? reading.canvas.h / reading.panel.h
    : 0;
  expect.soft(
    share,
    `${label}: the canvas region must keep ≥70% of the tab height — `
      + `canvas=${formatBox(reading.canvas)} panel=${formatBox(reading.panel)} share=${formatNumber(share)}`,
  ).toBeGreaterThanOrEqual(0.7);
};

const assertPhoneReadoutCollapsed = (reading: LayoutReading, label: string): void => {
  expect.soft(reading.readout, `${label}: the readout card must be measurable`).not.toBeNull();
  expect.soft(
    reading.readout?.h ?? Number.POSITIVE_INFINITY,
    `${label}: the collapsed phone readout is one line no taller than 44px — `
      + `readout=${formatBox(reading.readout)} text=${JSON.stringify(reading.readoutText)}`,
  ).toBeLessThanOrEqual(44);
};

const assertPhoneZoomClusterRow = (reading: LayoutReading, label: string): void => {
  expect.soft(reading.zoomCluster, `${label}: the zoom cluster must be measurable`).not.toBeNull();
  expect.soft(
    reading.zoomCluster?.h ?? Number.POSITIVE_INFINITY,
    `${label}: the phone zoom cluster is one horizontal row no taller than 52px — `
      + `cluster=${formatBox(reading.zoomCluster)}`,
  ).toBeLessThanOrEqual(52);
};

/* ── the guard's own legs ─────────────────────────────────────────────────────────────────── */

/**
 * Reading 0: the DEFAULT view is the whole drawing inside the canvas.
 *
 * This is the defect the task is filed against: on four measured sessions the
 * panel opened at 69% (a readable crop) instead of the drawing's real fit (as
 * low as 15%), so the reader had to drag to see the diagram they had just
 * opened. The leg reads the SVG's own box against the canvas region's box, so
 * "the whole drawing is on screen" is a relation between two boxes rather than
 * a mode name. It is read on the DRAWING THE TAB OPENS WITH, before any control
 * is pressed, on both viewports.
 */
const assertDefaultWholeGraph = (reading: LayoutReading, label: string): void => {
  expect.soft(reading.canvas, `${label}: the canvas region must exist`).not.toBeNull();
  expect.soft(reading.svg, `${label}: the drawing must be measurable`).not.toBeNull();
  expect.soft(
    reading.readableMode,
    `${label}: the default readable mode must be the whole-graph overview`,
  ).toBe('overview');
  const tolerance = 1;
  const inside = reading.svg !== null
    && reading.canvas !== null
    && reading.svg.x >= reading.canvas.x - tolerance
    && reading.svg.y >= reading.canvas.y - tolerance
    && reading.svg.x2 <= reading.canvas.x2 + tolerance
    && reading.svg.y2 <= reading.canvas.y2 + tolerance;
  expect.soft(
    inside,
    `${label}: the whole drawing must lie inside the canvas on open — `
      + `svg=${formatBox(reading.svg)} canvas=${formatBox(reading.canvas)}`,
  ).toBe(true);
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
  // The phone tier deliberately floats the readout on the drawing's top-left
  // (the mobile layout's single header row has no room for it). There "above
  // the drawing" is not the contract; "inside the canvas and clear of the
  // drawn nodes" is.
  if (reading.readoutPosition === 'absolute' || reading.readoutPosition === 'fixed') {
    expect.soft(
      reading.readoutOverNodes,
      `${label}: the floating readout must not cover a drawn node — `
        + `${reading.readoutOverNodes} node(s) overlap readout=${formatBox(reading.readout)}`,
    ).toBe(0);
    return;
  }
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

/* ── semantic zoom: minimum sizes, monotone layout, UML form ─────────────────────────────── */

/** A rectangle in CSS px, as the browser paints it. */
type LodRect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

/** One class box as the browser paints it. */
type SemanticClassBox = {
  readonly id: string;
  readonly rect: LodRect;
  /** The on-screen font sizes of the box's own labels, in CSS px. */
  readonly fonts: number[];
  /** How many compartment rules (plain `<line>`s) the frame draws. */
  readonly rules: number;
  /** `class`, `interface`, `enum`, `function`. */
  readonly kind: string;
  /** The centre the row-order reading sorts by. */
  readonly centreY: number;
};

/** One package frame and its tab. */
type SemanticPackageBox = {
  readonly id: string;
  readonly rect: LodRect;
  /** The tab's painted box, or null when the frame is too small for a tab. */
  readonly tab: LodRect | null;
  /** `true` when the tab path closes its right side (contains a `V` segment). */
  readonly tabClosed: boolean;
  /** The orange ★N badge text, or null. */
  readonly badge: string | null;
  /** The tab label's on-screen font size(s), in CSS px. */
  readonly fonts: number[];
};

/** One relation as the browser paints it. */
type SemanticEdgeReading = {
  readonly source: string | null;
  readonly target: string | null;
  readonly orthogonal: boolean;
  /** Does an end touch a visible class box's boundary? */
  readonly endpointOnFrame: boolean;
  /** Whether either endpoint's own entity is on screen (otherwise the leg is vacuous). */
  readonly checkable: boolean;
  /** The screen-space points the endpoint reading saw (diagnosis only). */
  readonly tail: { x: number; y: number }[];
};

/** Everything the semantic-zoom criterion reads, in one round trip. */
type SemanticReading = {
  readonly tier: string | null;
  readonly depth: string | null;
  readonly scale: number | null;
  readonly semantic: boolean;
  readonly classes: SemanticClassBox[];
  readonly packages: SemanticPackageBox[];
  /** `tab ∩ class` names: the reserved tab band must not be covered. */
  readonly tabOverlaps: string[];
  readonly edges: SemanticEdgeReading[];
};

/** The PC floor text size the design fixes; the phone tier is one px larger. */
const SEMANTIC_MIN_PC_PX = 10;
const SEMANTIC_MIN_PHONE_PX = 11;

/**
 * Read the semantic-zoom drawing in ONE round trip.
 *
 * Every reading below is taken from what the browser actually paints:
 * `getBoundingClientRect()` for boxes, `getScreenCTM()` for the font scale
 * (the SVG is shown 1:1 in semantic mode, so the matrix scale is 1 — reading it
 * rather than assuming is what lets a control arm move the text and be seen),
 * and the path `d` for endpoint/orthogonality. The same function is used by
 * the main arm and by every control arm.
 */
const readSemantic = (page: Page): Promise<SemanticReading> =>
  page.evaluate(({ sel }) => {
    const root = document.querySelector(sel.graphRoot);
    const number = (value: string | null): number | null => {
      if (value === null) return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const rectOf = (element: Element | null): { x: number; y: number; width: number; height: number } => {
      const rect = element === null ? null : element.getBoundingClientRect();
      return rect === null
        ? { x: 0, y: 0, width: 0, height: 0 }
        : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    /** Scale factor of an element's own user units → CSS px (x and y). */
    const screenScale = (element: Element | null): number => {
      if (element === null) return 0;
      const matrix = (element as SVGGraphicsElement).getScreenCTM?.() ?? null;
      return matrix === null ? 1 : Math.hypot(matrix.a, matrix.b);
    };
    const painted = (element: Element): boolean => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const intersects = (a: { x: number; y: number; width: number; height: number }): boolean =>
      a.width > 0 && a.height > 0 && a.x < window.innerWidth && a.x + a.width > 0
      && a.y < window.innerHeight && a.y + a.height > 0;
    const classes = [...document.querySelectorAll('.uml-node[data-entity-id]')]
      .filter((group) => painted(group) && intersects(rectOf(group)))
      .map((group) => {
        const texts = [...group.children].filter((child) => child.tagName.toLowerCase() === 'text')
          .filter((text) => painted(text) && (text.textContent ?? '').trim() !== '');
        const scale = screenScale(group);
        const stereotype = texts.map((text) => text.textContent ?? '').find((text) => /^<<\w+>>$/.test(text));
        const kind = stereotype?.replace(/[<>\s]/g, '') ?? 'class';
        const own = rectOf(group.querySelector('rect'));
        return {
          id: group.getAttribute('data-entity-id') ?? '',
          rect: own,
          fonts: texts.map((text) => {
            const declared = Number.parseFloat(getComputedStyle(text).fontSize);
            return (Number.isFinite(declared) ? declared : 0) * scale;
          }),
          rules: [...group.children].filter((child) => child.tagName.toLowerCase() === 'line').length,
          kind,
          centreY: own.y + own.height / 2,
        };
      });
    const packages = [...document.querySelectorAll('.uml-package[data-package-id]')]
      .filter((group) => painted(group) && intersects(rectOf(group)))
      .map((group) => {
        const path = [...group.children].find((child) => child.tagName.toLowerCase() === 'path') ?? null;
        const d = path?.getAttribute('d') ?? '';
        const badge = [...group.querySelectorAll('tspan')].map((span) => span.textContent ?? '').join('') || null;
        const scale = screenScale(group);
        const fonts = [...group.querySelectorAll('text')]
          .filter((text) => painted(text) && (text.textContent ?? '').trim() !== '')
          .map((text) => {
            const declared = Number.parseFloat(getComputedStyle(text).fontSize);
            return (Number.isFinite(declared) ? declared : 0) * scale;
          });
        return {
          id: group.getAttribute('data-package-id') ?? '',
          rect: rectOf(group.querySelector('rect')),
          tab: path === null ? null : rectOf(path),
          tabClosed: /\bV-?\d/.test(d),
          badge,
          fonts,
        };
      });
    const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean =>
      a.width > 0 && b.width > 0 && a.x < b.x + b.width && b.x < a.x + a.width
      && a.y < b.y + b.height && b.y < a.y + a.height;
    const tabOverlaps: string[] = [];
    for (const pkg of packages) {
      if (pkg.tab === null || pkg.tab.width <= 0) continue;
      for (const box of classes) {
        if (overlap(pkg.tab, box.rect)) tabOverlaps.push(`${pkg.id} ∩ ${box.id}`);
      }
    }
    const onFrame = (point: { x: number; y: number }): boolean => classes.some((box) => {
      const { x, y, width, height } = box.rect;
      const eps = 3;
      const withinX = point.x >= x - eps && point.x <= x + width + eps;
      const withinY = point.y >= y - eps && point.y <= y + height + eps;
      const onLeft = Math.abs(point.x - x) <= eps && withinY;
      const onRight = Math.abs(point.x - (x + width)) <= eps && withinY;
      const onTop = Math.abs(point.y - y) <= eps && withinX;
      const onBottom = Math.abs(point.y - (y + height)) <= eps && withinX;
      return onLeft || onRight || onTop || onBottom;
    });
    const screenOf = (element: SVGElement, point: { x: number; y: number }): { x: number; y: number } => {
      const matrix = element.getScreenCTM?.() ?? null;
      return matrix === null
        ? point
        : {
            x: matrix.a * point.x + matrix.c * point.y + matrix.e,
            y: matrix.b * point.x + matrix.d * point.y + matrix.f,
          };
    };
    const edges = [...document.querySelectorAll('.uml-edge[data-edge-source][data-edge-target]')]
      .filter((group) => painted(group))
      .map((group) => {
        const path = group.querySelector('path') as SVGPathElement | null;
        const d = path?.getAttribute('d') ?? '';
        const points: { x: number; y: number }[] = [];
        // M/L endpoints only: a rounded corner's Q control point is not a bend.
        for (const command of d.match(/[ML][^MLQZz]*/g) ?? []) {
          const values = (command.slice(1).match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
          if (values.length >= 2) points.push({ x: values[0], y: values[1] });
        }
        // The arrow's own points are part of the ENDPOINT the reader sees: the
        // line is trimmed by the arrow size, so the tip — not the line — is
        // what touches the frame.
        const polygon = group.querySelector('polygon');
        const arrowPoints = (polygon?.getAttribute('points') ?? '')
          .trim()
          .split(/\s+/)
          .map((pair) => pair.split(',').map(Number))
          .filter((pair) => pair.length === 2 && Number.isFinite(pair[0]) && Number.isFinite(pair[1]))
          .map(([x, y]) => ({ x, y }));
        const tail = [
          ...points.slice(0, 2).map((point) => (path === null ? point : screenOf(path, point))),
          ...points.slice(-2).map((point) => (path === null ? point : screenOf(path, point))),
          ...arrowPoints.map((point) => (polygon === null ? point : screenOf(polygon as SVGElement, point))),
        ];
        const visibleIds = new Set(classes.map((box) => box.id));
        const source = group.getAttribute('data-edge-source');
        const target = group.getAttribute('data-edge-target');
        return {
          source,
          target,
          orthogonal: true,
          endpointOnFrame: tail.some((point) => onFrame(point)),
          // An edge whose two ends are both scrolled out has no frame on
          // screen to touch; that is not a defect in the mapping.
          checkable: (source !== null && visibleIds.has(source)) || (target !== null && visibleIds.has(target)),
          tail,
        };
      });
    return {
      tier: document.querySelector('svg[data-architecture-semantic]')?.getAttribute('data-architecture-semantic') ?? null,
      depth: root?.getAttribute('data-architecture-lod-depth') ?? null,
      scale: number(root?.getAttribute('data-architecture-zoom-scale') ?? null),
      semantic: document.querySelector('svg[data-architecture-semantic]') !== null,
      classes,
      packages,
      tabOverlaps,
      edges,
    };
  }, { sel: SEL });

/** Print the semantic reading so a red can be read against the state. */
const printSemantic = (label: string, reading: SemanticReading): void => {
  console.log(
    `[architecture-semantic] ${label} tier=${reading.tier} depth=${reading.depth} `
    + `zoom=${formatNumber(reading.scale)} classes=${reading.classes.length} packages=${reading.packages.length} `
    + `tabOverlaps=${JSON.stringify(reading.tabOverlaps)}`,
  );
  console.log(`[architecture-semantic] ${label}.fonts=${JSON.stringify(reading.classes.map((box) => [box.id, box.fonts]))}`);
  console.log(`[architecture-semantic] ${label}.edges=${JSON.stringify(reading.edges.map((edge) => [edge.source, edge.target, edge.endpointOnFrame]))}`);
  console.log(`[architecture-semantic] ${label}.tabs=${JSON.stringify(reading.packages.map((pkg) => [pkg.id, pkg.tab]))}`);
  console.log(`[architecture-semantic] ${label}.boxes=${JSON.stringify(reading.classes.map((box) => [box.id, box.rect]))}`);
  console.log(`[architecture-semantic] ${label}.tails=${JSON.stringify(reading.edges.filter((edge) => !edge.endpointOnFrame).slice(0, 12).map((edge) => {
    const targetBox = reading.classes.find((box) => box.id === edge.target);
    const sourceBox = reading.classes.find((box) => box.id === edge.source);
    return [edge.source, edge.target, edge.tail, sourceBox?.rect ?? null, targetBox?.rect ?? null];
  }))}`);
};

/** The row order of the class boxes: ids left-to-right, grouped by painted row. */
const classRowOrder = (reading: SemanticReading): string[][] => {
  const rows: { key: number; entries: SemanticClassBox[] }[] = [];
  for (const box of [...reading.classes].sort((a, b) => a.centreY - b.centreY)) {
    const row = rows.find((candidate) => Math.abs(candidate.key - box.centreY) <= 4);
    if (row === undefined) rows.push({ key: box.centreY, entries: [box] });
    else row.entries.push(box);
  }
  return rows
    .sort((a, b) => a.key - b.key)
    .map((row) => row.entries.sort((a, b) => a.rect.x - b.rect.x).map((box) => box.id));
};

/**
 * The criterion: every visible text is at least the minimum size; every class
 * frame keeps its two rules (one for an operations-only interface); no package
 * tab paints over a class box; the tab closes on its right; the row order is
 * the baseline's; an edge endpoint sits on a visible frame; and at tier C no
 * class box is drawn and a package holding a mentioned entity carries ★N.
 */
const assertSemantic = (
  reading: SemanticReading,
  label: string,
  minFontPx: number,
  baselineRows: string[][] | null,
): string[][] => {
  expect.soft(reading.semantic, `${label}: the drawing must be semantically laid out`).toBe(true);
  for (const box of reading.classes) {
    for (const font of box.fonts) {
      expect.soft(
        font,
        `${label}: text in ${box.id} must be at least ${minFontPx}px on screen; got ${formatNumber(font)}px`,
      ).toBeGreaterThanOrEqual(minFontPx - 0.05);
    }
    const expectedRules = box.kind === 'interface' || box.kind === 'function' ? 1 : 2;
    expect.soft(
      box.rules,
      `${label}: ${box.kind} box ${box.id} must draw ${expectedRules} compartment rule(s); got ${box.rules}`,
    ).toBeGreaterThanOrEqual(expectedRules);
  }
  expect.soft(
    reading.tabOverlaps,
    `${label}: a package tab must not paint over a class box; overlaps=${JSON.stringify(reading.tabOverlaps)}`,
  ).toEqual([]);
  for (const pkg of reading.packages) {
    if (pkg.tab === null) continue;
    expect.soft(pkg.tabClosed, `${label}: package tab ${pkg.id} must close on its right side`).toBe(true);
    for (const font of pkg.fonts) {
      expect.soft(
        font,
        `${label}: package tab text in ${pkg.id} must be at least ${minFontPx}px on screen; got ${formatNumber(font)}px`,
      ).toBeGreaterThanOrEqual(minFontPx - 0.05);
    }
  }
  const rows = classRowOrder(reading);
  if (baselineRows !== null) {
    // Compare the ORDER of pairs that were on one row in the baseline and are
    // still on one row now. The visible set grows as the drawing shrinks, so a
    // whole-row equality would compare different populations; a pair that
    // never leaves its row is the monotonicity claim itself.
    const now = new Map(reading.classes.map((box) => [box.id, box]));
    for (const row of baselineRows) {
      for (let left = 0; left < row.length; left += 1) {
        for (let right = left + 1; right < row.length; right += 1) {
          const a = now.get(row[left]);
          const b = now.get(row[right]);
          if (a === undefined || b === undefined) continue;
          if (Math.abs(a.centreY - b.centreY) > 6) continue;
          expect.soft(
            a.rect.x <= b.rect.x,
            `${label}: ${row[left]} must stay left of ${row[right]} on their shared row`,
          ).toBe(true);
        }
      }
    }
  }
  for (const edge of reading.edges) {
    if (!edge.checkable) continue;
    expect.soft(
      edge.endpointOnFrame,
      `${label}: relation ${edge.source} → ${edge.target} must end on a visible frame boundary`,
    ).toBe(true);
  }
  if (reading.tier === 'C') {
    expect.soft(reading.classes.length, `${label}: tier C must draw no class box`).toBe(0);
    const badged = reading.packages.filter((pkg) => pkg.badge !== null && pkg.badge !== '').map((pkg) => pkg.id);
    if (badged.length === 0) {
      // The fixture's mentions may fall in a package whose tab is off-screen;
      // the criterion states the rule where a badge is drawn.
      console.log(`[architecture-semantic] ${label}: no visible ★N badge on screen at this scroll position`);
    }
  }
  return rows;
};

/** Drive the real zoom control until the applied scale lands near `target`. */
async function zoomToScale(page: Page, target: number): Promise<number> {
  const seen = new Set<string>();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const raw = Number(await page.locator(SEL.graphRoot).getAttribute('data-architecture-zoom-scale') ?? '1');
    // The zoom steps by 1.25×, so an exact target is not always reachable: stop
    // inside a quarter-step, or when a step would keep revisiting the same value
    // (the two neighbours of an unreachable target).
    if (Math.abs(raw - target) <= target * 0.13 + 0.01) break;
    const key = raw.toFixed(4);
    if (seen.has(key)) break;
    seen.add(key);
    const control = raw > target ? SEL.zoomOut : SEL.zoomIn;
    await page.locator(control).first().click();
    await page.waitForTimeout(40);
  }
  // The semantic pass runs on a 200ms debounce; wait for it to publish the
  // scale it actually laid out (not the click's intermediate value).
  await page.waitForFunction(
    ({ wanted }) => {
      const svg = document.querySelector('svg[data-architecture-semantic]');
      if (svg === null) return false;
      const applied = Number(svg.getAttribute('data-architecture-semantic-scale') ?? '0');
      return applied > 0 && Math.abs(applied - wanted) <= 0.12;
    },
    { sel: SEL, wanted: Number(await page.locator(SEL.graphRoot).getAttribute('data-architecture-zoom-scale') ?? '1') },
    { timeout: 15_000 },
  ).catch(() => undefined);
  await settle(page, 320);
  return Number(await page.locator(SEL.graphRoot).getAttribute('data-architecture-zoom-scale') ?? '1');
}

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

  // The canvas-layout readings in this file are specified on the FILE overview:
  // it is the drawing that fills the canvas with box nodes at a whole-graph fit
  // (directory groups), which is what the chrome/readout readings measure. The
  // class view now opens on its semantic-zoom hierarchy, whose whole-graph fit
  // deliberately hides the entity boxes into package counts — there is no box
  // reading to take there. The class drawing has its own criteria (the panel's
  // architectureTab tests and the task's browser record); this guard keeps
  // measuring the drawing it was written against.
  await page.locator('[data-architecture-view-option="file"]').first().click();
  await waitForDrawing(page);
  // The file drawing is a SECOND drawing in this page: the corner chrome (the
  // zoom cluster, and the minimap where the tier shows one) is re-measured and
  // the fit re-run a beat after it mounts, so give that re-fit its frame before
  // the arms read the layout.
  await settle(page, 1200);
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

/* ── the text-selection reading ──────────────────────────────────────────────────────────── */

/** What the page's live selection holds. The ONE reading both arms compare. */
type SelectionReading = { length: number; text: string };

const readTextSelection = (page: Page): Promise<SelectionReading> => page.evaluate(() => {
  const text = window.getSelection()?.toString() ?? '';
  return { length: text.length, text: text.slice(0, 120) };
});

/** Drop any range the previous gesture left, so a reading names this gesture only. */
async function clearTextSelection(page: Page): Promise<void> {
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
}

type GesturePoint = { x: number; y: number };

/**
 * Two press points inside the drawing: a genuinely blank spot of canvas and a
 * node label.
 *
 * The blank point is found by hit-testing, not by assuming a corner: the
 * drawing's corner chrome (minimap, zoom cluster, header) and every drawn node
 * refuse the press, and their placement moves with the fit. The label point is
 * the centre of a drawn `text` inside a node box — the element a reader drags
 * from when they select a label by accident.
 */
async function findGesturePoints(page: Page): Promise<{ blank: GesturePoint | null; label: GesturePoint | null }> {
  return page.evaluate((sel) => {
    const host = document.querySelector(sel.host) as HTMLElement | null;
    if (host === null) return { blank: null, label: null };
    const hostRect = host.getBoundingClientRect();
    const inside = (x: number, y: number): boolean =>
      x > hostRect.left + 6 && x < hostRect.right - 6 && y > hostRect.top + 6 && y < hostRect.bottom - 6;
    const isBlankCanvas = (x: number, y: number): boolean => {
      const hit = document.elementFromPoint(x, y);
      if (hit === null) return false;
      if (hit.closest('[data-entity-id]') !== null) return false;
      if (hit.closest('[data-architecture-canvas-overlays]') !== null) return false;
      if (hit.closest('[data-architecture-canvas-header]') !== null) return false;
      return hit === host || host.contains(hit);
    };

    let blank: { x: number; y: number } | null = null;
    const columns = 16;
    const rows = 12;
    outer: for (let row = 1; row < rows; row += 1) {
      for (let column = 1; column < columns; column += 1) {
        const x = Math.round(hostRect.left + (hostRect.width * column) / columns);
        const y = Math.round(hostRect.top + (hostRect.height * row) / rows);
        if (inside(x, y) && isBlankCanvas(x, y)) {
          blank = { x, y };
          break outer;
        }
      }
    }

    let label: { x: number; y: number } | null = null;
    for (const node of host.querySelectorAll('.uml-node')) {
      const text = node.querySelector('text');
      if (text === null) continue;
      const rect = text.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 6) continue;
      const point = {
        x: Math.round(rect.left + Math.min(rect.width / 2, 30)),
        y: Math.round(rect.top + rect.height / 2),
      };
      if (!inside(point.x, point.y)) continue;
      const hit = document.elementFromPoint(point.x, point.y);
      if (hit === null || hit.closest('[data-entity-id]') === null) continue;
      label = point;
      break;
    }

    return { blank, label };
  }, SEL);
}

/**
 * A real primary-button drag: press, travel in frames, release. Small moves in
 * several steps, because a single jump can land as one `mousemove` and the
 * browser's own selection extension is what this criterion is measuring.
 */
async function dragAcross(page: Page, from: GesturePoint, to: GesturePoint): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 6;
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(
      Math.round(from.x + ((to.x - from.x) * step) / steps),
      Math.round(from.y + ((to.y - from.y) * step) / steps),
    );
  }
  await page.mouse.up();
}

/**
 * The canvas selection legs: blank drag, label drag, double-clicked label.
 *
 * Each gesture starts from a clean selection and its own reading; a leg that
 * leaves a range behind names itself in the console line and in the red.
 */
async function assertCanvasSelectsNothing(
  page: Page,
  points: { blank: GesturePoint | null; label: GesturePoint | null },
  label: string,
): Promise<void> {
  expect(points.blank, `${label}: the drawing must offer a blank spot to drag from`).not.toBeNull();
  expect(points.label, `${label}: the drawing must offer a node label to drag from`).not.toBeNull();
  const blank = points.blank as GesturePoint;
  const nodeLabel = points.label as GesturePoint;

  const gestures: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: 'blank-drag',
      run: () => dragAcross(page, blank, { x: Math.max(blank.x - 160, 10), y: Math.max(blank.y - 110, 10) }),
    },
    {
      name: 'label-drag',
      run: () => dragAcross(page, nodeLabel, { x: nodeLabel.x + 120, y: nodeLabel.y + 60 }),
    },
    {
      name: 'label-double-click',
      run: () => page.mouse.dblclick(nodeLabel.x, nodeLabel.y),
    },
  ];

  for (const gesture of gestures) {
    await clearTextSelection(page);
    await gesture.run();
    await settle(page, 200);
    const reading = await readTextSelection(page);
    // The DoD's screenshot: the drawing right after the gesture, with no
    // selection highlight on it.
    await page.screenshot({ path: test.info().outputPath(`selection-${label}-${gesture.name}.png`) });
    console.log(`[architecture-layout] selection.${label}.${gesture.name}=${JSON.stringify(reading)}`);
    expect(
      reading.length,
      `${label}: ${gesture.name} must not select the drawing; it selected ${reading.length} characters: `
        + `${JSON.stringify(reading.text)}`,
    ).toBe(0);
  }
  await clearTextSelection(page);
}

/**
 * The dock leg: the same drag over the inspector's own prose MUST select text.
 *
 * The dock is the copyable side of the panel (session hits, the PlantUML text),
 * and it sits beside — never inside — the canvas region, so this is the
 * "did the fix spill over?" reading. The longest visible text block in the dock
 * is the target; if the inspector is showing only short labels, the Text tab
 * provides the document the reader is meant to copy from.
 */
async function assertDockSelectsText(page: Page, label: string): Promise<void> {
  const dock = page.locator('[role="complementary"]');
  if ((await dock.count()) === 0) {
    // Open it the way a reader does: a single click on a drawn node.
    const points = await findGesturePoints(page);
    expect(points.label, `${label}: the drawing must offer a node to select`).not.toBeNull();
    await page.mouse.click((points.label as GesturePoint).x, (points.label as GesturePoint).y);
  }
  await expect(dock, `${label}: the inspector dock must open for a selection`).toBeVisible({ timeout: 10_000 });

  // The dock slides in over 160ms. Its rect is what the drag targets, so wait
  // for the slide to land: a rect taken mid-animation points where the dock no
  // longer is, and the drag would land on the canvas instead of the prose.
  await page.evaluate(() => new Promise<void>((resolve) => {
    const element = document.querySelector('[role="complementary"]');
    if (element === null) {
      resolve();
      return;
    }
    let previous = element.getBoundingClientRect().left;
    let stable = 0;
    const tick = (): void => {
      const current = element.getBoundingClientRect().left;
      stable = Math.abs(current - previous) < 0.5 ? stable + 1 : 0;
      previous = current;
      if (stable >= 3) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));

  const readTextBlock = () => page.evaluate(() => {
    const root = document.querySelector('[role="complementary"]');
    if (root === null) return null;
    let best: { x: number; x2: number; y: number; text: string } | null = null;
    for (const element of root.querySelectorAll('p, dd, li, pre, code, span')) {
      // Buttons are unselectable by the app's global stylesheet — a label that
      // happens to be a control is not prose, so it is not a valid target.
      if (element.closest('button, [role="button"], a, [role="menuitem"]') !== null) continue;
      if (element.querySelector('button') !== null) continue;
      const text = (element.textContent ?? '').trim();
      if (text.length < 8) continue;
      const rect = element.getBoundingClientRect();
      // Only the part of the block that is actually ON SCREEN can be dragged:
      // a mouse move past the viewport edge selects nothing, and a partially
      // clipped block would otherwise turn this leg into a vacuous 0.
      const left = Math.max(rect.left + 3, 4);
      const right = Math.min(rect.right - 3, window.innerWidth - 4);
      const y = Math.round(rect.top + rect.height / 2);
      if (right - left < 20) continue;
      if (y < 6 || y > window.innerHeight - 6) continue;
      if (best === null || text.length > best.text.length) {
        const x = Math.round(left);
        const x2 = Math.round(right);
        const hit = document.elementFromPoint(x, y);
        best = {
          x,
          x2,
          y,
          text: text.slice(0, 60),
          policy: window.getComputedStyle(element).userSelect,
          hit: hit === null ? 'none' : `${hit.tagName.toLowerCase()}${hit.className ? `.${String(hit.className).split(' ')[0]}` : ''}`,
        };
      }
    }
    return best;
  });

  let block = await readTextBlock();
  if (block === null) {
    const textTab = page.getByRole('tab', { name: 'Text' });
    if ((await textTab.count()) > 0) {
      await textTab.first().click();
      await expect(page.locator('[data-architecture-text-preview]')).toBeVisible({ timeout: 10_000 });
      await settle(page, 300);
      block = await readTextBlock();
    }
  }
  expect(block, `${label}: the dock must show text a reader can copy`).not.toBeNull();
  const target = block as {
    x: number;
    x2: number;
    y: number;
    text: string;
    policy: string;
    hit: string;
  };
  const geometry = await page.evaluate(() => {
    const dock = document.querySelector('[role="complementary"]');
    const rect = dock?.getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      scrollX: window.scrollX,
      dock: rect === undefined ? null : { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) },
    };
  });
  console.log(`[architecture-layout] selection.${label}.dock-geometry=${JSON.stringify(geometry)}`);
  console.log(`[architecture-layout] selection.${label}.dock-target=${JSON.stringify(target)}`);

  await clearTextSelection(page);
  await dragAcross(page, { x: target.x, y: target.y }, { x: target.x2, y: target.y });
  await settle(page, 200);
  const reading = await readTextSelection(page);
  // The DoD's screenshot, the other direction: the dock's text under a live
  // browser selection.
  await page.screenshot({ path: test.info().outputPath(`selection-${label}-dock-drag.png`) });
  console.log(`[architecture-layout] selection.${label}.dock-drag=${JSON.stringify(reading)}`);
  expect(
    reading.length,
    `${label}: dragging over the dock's text MUST select it (the fix must not reach the dock); `
      + `selected ${reading.length} characters over ${JSON.stringify(target.text)}`,
  ).toBeGreaterThan(0);
  await clearTextSelection(page);
}

/**
 * Open the phone tier's bottom sheet, where the renderer's view controls live.
 *
 * A no-op on the desktop tier (there is no `Adjust` button). On a phone the
 * sheet is a modal dialog, so it must be CLOSED again before any geometry leg
 * is read — otherwise the sheet, not the drawing, is what the viewport shows.
 */
async function openControlSheet(page: Page): Promise<boolean> {
  const toggle = page.locator(SEL.sheetToggle);
  if ((await toggle.count()) === 0) return false;
  if ((await page.locator(SEL.sheet).count()) === 0) await toggle.first().click();
  await expect(page.locator(SEL.sheet)).toBeVisible({ timeout: 10_000 });
  return true;
}

/** Close the phone tier's bottom sheet if it is open; a no-op on desktop. */
async function closeControlSheet(page: Page): Promise<void> {
  const close = page.locator(SEL.sheetClose);
  if ((await close.count()) === 0) return;
  await close.first().click();
  await expect(page.locator(SEL.sheet)).toHaveCount(0, { timeout: 10_000 });
}

/**
 * The whole-graph view: the only state whose scale is computed to keep the
 * drawing clear of the corner chrome.
 */
async function showWholeGraph(page: Page): Promise<void> {
  // On the phone tier the control lives inside the bottom sheet.
  await openControlSheet(page);
  const overview = page.locator(SEL.overviewMode);
  if ((await overview.count()) > 0 && (await overview.first().isVisible())) {
    await overview.first().click();
    await page.waitForFunction(
      (sel) => document.querySelector(sel.graphRoot)?.getAttribute('data-architecture-readable-mode') === 'overview',
      SEL,
      { timeout: 15_000 },
    );
  }
  await closeControlSheet(page);
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
 *
 * The CLASS graph already opens on that drawing (hierarchy is its default, so
 * the "Explosion view" control is not offered there); only the FILE graph's
 * overview needs the explicit switch. The wait below is the common contract.
 */
async function showExplosionView(page: Page): Promise<void> {
  const alreadyExploded = await page.locator(SEL.graphRoot).getAttribute('data-architecture-view') === 'hierarchy';
  if (!alreadyExploded) {
    // On the phone tier the explosion control lives inside the bottom sheet.
    await openControlSheet(page);
    const explosion = page.locator(SEL.explosion);
    expect(await explosion.count(), 'the panel must offer the explosion view this reading draws').toBeGreaterThan(0);
    await explosion.first().click();
    await closeControlSheet(page);
  }
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

/**
 * Zoom out through the on-canvas cluster until the applied scale is under the
 * 12% useful-overview floor, then wait for the LOD to settle at the package
 * level (where the package frames are visible and tappable).
 *
 * This is the state a default fit on a phone already reaches for a large
 * drawing; driving it with the real zoom-out control keeps the case honest on
 * a fixture whose default fit happens to be larger.
 */
async function zoomOutBelowUsefulScale(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const raw = await page.locator(SEL.graphRoot).getAttribute('data-architecture-zoom-scale');
    const scale = Number(raw ?? '1');
    if (Number.isFinite(scale) && scale > 0 && scale < 0.12) break;
    await page.locator(SEL.zoomOut).first().click();
    await page.waitForTimeout(120);
  }
  await page.waitForFunction(
    (sel) => {
      const raw = Number(document.querySelector(sel.graphRoot)?.getAttribute('data-architecture-zoom-scale') ?? '1');
      return raw > 0 && raw < 0.12;
    },
    SEL,
    { timeout: 15_000 },
  );
  // The tier is budget-driven now, so the state that matters is the semantic
  // pass having settled — not a particular depth. A package frame is the
  // gesture target either way.
  await page.waitForFunction(
    () => document.querySelector('svg[data-architecture-semantic]') !== null
      && document.querySelectorAll('.uml-package[data-package-id]').length > 0,
    undefined,
    { timeout: 15_000 },
  );
  // One debounce window plus the semantic rewrite.
  await settle(page, 400);
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

    // Reading 0, on the drawing the tab OPENS WITH: the whole graph is inside
    // the canvas before any control is pressed. The shipped default cropped it
    // to a readable 69% and left the reader dragging.
    const opened = await readLayout(page);
    printReading('pc.default', opened);
    assertDefaultWholeGraph(opened, 'pc.default');
    assertFitNearTheoretical(opened, 'pc.default');

    // The search combobox: typing a seed name must open a list that is fully
    // usable — the shipped layout clipped it to a 3px line under the toolbar.
    // A stem shared by many drawn entities, so the list is tall enough to have a
    // meaningful visible centre (one row would make the reading vacuous).
    const searchQuery = 'Stage';
    await page.locator(SEL.search).first().fill(searchQuery);
    await expect(page.locator(SEL.searchResults).first()).toBeVisible({ timeout: 10_000 });
    const search = await readSearch(page);
    console.log(`[architecture-layout] pc.search=${JSON.stringify(search)}`);
    assertSearchUsable(search, 'pc.search');
    // The arrow keys move the active option in the real browser too.
    await page.locator(SEL.search).first().press('ArrowDown');
    const activeOption = await page.locator(SEL.search).first().getAttribute('aria-activedescendant');
    expect(
      activeOption,
      'ArrowDown must move the combobox onto an option of the drawn list',
    ).not.toBeNull();
    expect(
      await page.locator(`[id="${activeOption}"]`).getAttribute('aria-selected'),
      'the active option must be announced as selected',
    ).toBe('true');
    await page.locator(SEL.search).first().fill('');
    await page.keyboard.press('Escape');

    await showWholeGraph(page);

    const fitted = await readLayout(page);
    printReading('pc.fitted', fitted);
    assertCanvasFilled(fitted, 'pc.fitted');
    assertReadoutAboveDrawing(fitted, 'pc.fitted');
    assertChromeClearOfNodes(fitted, 'pc.fitted');
    assertFooterInFlow(fitted, 'pc.fitted');
    assertFitNearTheoretical(fitted, 'pc.fitted');

    // The drawing is an instrument, not text: dragging from the blank canvas,
    // dragging from a node label and double-clicking a label (the drill
    // gesture) must all leave `window.getSelection()` empty. The dock beside it
    // is the copyable side and must still select — both legs read through the
    // same `readTextSelection`, so a green here is a comparison, not a claim.
    const points = await findGesturePoints(page);
    await assertCanvasSelectsNothing(page, points, 'pc');
    await assertDockSelectsText(page, 'pc');

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

    // Reading 0 on the phone viewport: the whole drawing must be inside the
    // canvas on open, without the reader panning the drawing they just opened.
    const opened = await readLayout(page);
    printReading('phone.default', opened);
    assertDefaultWholeGraph(opened, 'phone.default');
    assertFitNearTheoretical(opened, 'phone.default');

    await showWholeGraph(page);

    const fitted = await readLayout(page);
    printReading('phone.fitted', fitted);
    assertCanvasFilled(fitted, 'phone.fitted');
    assertReadoutAboveDrawing(fitted, 'phone.fitted');
    assertChromeClearOfNodes(fitted, 'phone.fitted');
    assertFooterInFlow(fitted, 'phone.fitted');
    assertFitNearTheoretical(fitted, 'phone.fitted');

    // A whole graph that falls under the useful scale offers the hint, and a
    // package tap zooms in with a way back. The explosion view draws the
    // package frames the gesture names; the zoom-out path then reaches the
    // same tiny state a default fit on a large drawing would.
    await showExplosionView(page);
    const exploded = await readLayout(page);
    printReading('phone.exploded.fitted', exploded);
    // The density contract: the drawing really fills the canvas, the readout is
    // one 44px line and the zoom cluster is one 52px row.
    assertPhoneDrawingFillsCanvas(exploded, 'phone.exploded.fitted');
    assertPhoneRegionHeight(exploded, 'phone.exploded.fitted');
    assertPhoneReadoutCollapsed(exploded, 'phone.exploded.fitted');
    assertPhoneZoomClusterRow(exploded, 'phone.exploded.fitted');

    await zoomOutBelowUsefulScale(page);
    const tiny = await readLayout(page);
    printReading('phone.tiny', tiny);
    await expect(
      page.locator(SEL.readableHint),
      'a phone overview below 12% must say so and offer a package to tap',
    ).toBeVisible({ timeout: 10_000 });
    expect(
      await page.locator(SEL.readableBack).count(),
      'nothing has been zoomed into yet, so there is no back action',
    ).toBe(0);

    const scaleBeforePackage = Number(
      await page.locator(SEL.graphRoot).getAttribute('data-architecture-zoom-scale'),
    );
    await page.locator('.uml-package[data-package-id]').first().dispatchEvent('click');
    await page.waitForFunction(
      ({ sel, before }) => {
        const root = document.querySelector(sel.graphRoot);
        return Number(root?.getAttribute('data-architecture-zoom-scale') ?? '0') > before
          && root?.getAttribute('data-architecture-zoom-mode') === 'custom';
      },
      { sel: SEL, before: scaleBeforePackage },
      { timeout: 10_000 },
    );
    console.log(`[architecture-layout] phone.package.tap=${scaleBeforePackage} -> ${
      await page.locator(SEL.graphRoot).getAttribute('data-architecture-zoom-scale')}`);
    await expect(
      page.locator(SEL.readableBack),
      'after zooming into a package the hint row offers the way back',
    ).toBeVisible({ timeout: 10_000 });
    await page.locator(SEL.readableBack).click();
    await page.waitForFunction(
      (sel) => document.querySelector(sel.graphRoot)?.getAttribute('data-architecture-zoom-mode') === 'fit',
      SEL,
      { timeout: 10_000 },
    );
    expect(
      await page.locator(SEL.readableBack).count(),
      'back on the whole graph, the back action is gone',
    ).toBe(0);

    // The Adjust sheet labels every group and keeps the stepper's controls
    // visible — the phone tier's two review findings.
    if (await openControlSheet(page)) {
      const sections = await page.evaluate((sel) => {
        const sheet = document.querySelector(sel.sheet);
        if (sheet === null) return null;
        const names = ['view', 'scope', 'detail', 'filter', 'export', 'legend'];
        return names.map((name) => {
          const section = sheet.querySelector(`[data-architecture-sheet-${name}]`);
          return {
            name,
            present: section !== null,
            title: (section?.querySelector('span')?.textContent ?? '').trim(),
          };
        });
      }, SEL);
      console.log(`[architecture-layout] phone.sheet.sections=${JSON.stringify(sections)}`);
      expect(sections, 'the Adjust sheet must draw its groups').not.toBeNull();
      for (const section of sections ?? []) {
        expect.soft(section.present, `Adjust must draw the ${section.name} group`).toBe(true);
        expect.soft(section.title.length, `Adjust's ${section.name} group must carry a title`).toBeGreaterThan(0);
      }
      const stepper = await page.evaluate((sel) => {
        const sheet = document.querySelector(sel.sheet);
        const buttons = sheet === null
          ? []
          : [...sheet.querySelectorAll('[data-architecture-scope-decrease], [data-architecture-scope-increase]')]
            .map((button) => {
              const rect = button.getBoundingClientRect();
              return { w: rect.width, h: rect.height, border: getComputedStyle(button).borderTopWidth };
            });
        return buttons;
      }, SEL);
      console.log(`[architecture-layout] phone.sheet.stepper=${JSON.stringify(stepper)}`);
      expect(stepper.length, 'the scope stepper must expose its two buttons').toBe(2);
      for (const button of stepper) {
        expect.soft(button.w, `the scope stepper's buttons must be 44px wide: ${JSON.stringify(button)}`).toBeGreaterThanOrEqual(44);
        expect.soft(button.h, `the scope stepper's buttons must be 44px tall: ${JSON.stringify(button)}`).toBeGreaterThanOrEqual(44);
        expect.soft(
          Number.parseFloat(button.border) > 0,
          `the scope stepper's buttons must draw a visible border: ${JSON.stringify(button)}`,
        ).toBe(true);
      }
      await closeControlSheet(page);
    }

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

/* ── the semantic-zoom main arm ──────────────────────────────────────────────────────────── */

/**
 * The five zoom levels the design was iterated at, as applied scales. 100% is
 * the restored baseline; the rest are the reference montage's readings.
 */
const SEMANTIC_ZOOM_LEVELS = [1, 0.65, 0.46, 0.33, 0.17, 0.06] as const;

/**
 * The semantic-zoom criterion, in a real browser, on both viewports.
 *
 * For every level the SAME reading answers: is any visible text under the
 * minimum screen size, does every class frame keep its compartment rules, does
 * a package tab cover a class box, does the tab close on the right, has the
 * row order inverted, does an edge end away from its frame — and, at tier C,
 * are the class boxes gone while the package tabs still say their counts. The
 * row order is compared against the 100% reading of the SAME drawing, which is
 * what makes "monotone" a reading rather than an assumption.
 */
test('main arm — semantic zoom keeps text readable, UML form and order at five levels', async ({ browser }) => {
  const viewports = [
    { name: 'pc', viewport: VIEWPORT_PC, touch: false, minFontPx: SEMANTIC_MIN_PC_PX },
    { name: 'phone', viewport: VIEWPORT_PHONE, touch: true, minFontPx: SEMANTIC_MIN_PHONE_PX },
  ];
  for (const form of viewports) {
    const { context, page } = await openSignedInPage(browser, baseURL, token, {
      viewport: form.viewport,
      touch: form.touch,
    });
    try {
      await openArchitectureTab(page, sessionId);
      await showExplosionView(page);

      await zoomToScale(page, 1);
      const base = await readSemantic(page);
      printSemantic(`${form.name}.base`, base);
      const baselineRows = assertSemantic(base, `${form.name}.base`, form.minFontPx, null);

      for (const level of SEMANTIC_ZOOM_LEVELS.slice(1)) {
        await zoomToScale(page, level);
        const reading = await readSemantic(page);
        printSemantic(`${form.name}.${Math.round(level * 100)}`, reading);
        assertSemantic(
          reading,
          `${form.name}.${Math.round(level * 100)}`,
          form.minFontPx,
          baselineRows,
        );
      }
    } finally {
      await context.close();
    }
  }
});

/* ── the semantic-zoom control arms (see the file header) ────────────────────────────────── */

/**
 * Every semantic guard, forced red through the SAME `readSemantic`.
 *
 * Four defects, one per guard: text below the floor, a tab over a class box, an
 * edge endpoint pulled off its frame, and two same-row boxes swapped. Each is
 * injected into the live drawing (the state the shipped drawing would have if
 * the feature were absent), read through the same function that just passed,
 * and restored — so both sides of every arm are measured in one page state.
 */
test('control arm — each semantic guard reads a false when its defect is injected', async ({ browser }) => {
  const { context, page } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PC,
    touch: false,
  });
  try {
    await openArchitectureTab(page, sessionId);
    await showExplosionView(page);
    await zoomToScale(page, 0.33);

    const before = await readSemantic(page);
    printSemantic('control.before', before);
    const baselineRows = assertSemantic(before, 'control.before', SEMANTIC_MIN_PC_PX, null);
    expect(before.classes.length, 'control.before: the arm needs class boxes').toBeGreaterThan(1);
    expect(
      before.edges.some((edge) => edge.endpointOnFrame),
      'control.before: the arm needs an edge endpoint on a frame',
    ).toBe(true);

    // Arm 1 — minimum font size off.
    await page.evaluate(() => {
      for (const text of document.querySelectorAll('.uml-node[data-entity-id] > text')) {
        (text as SVGElement).setAttribute('data-control-fontsize', text.getAttribute('font-size') ?? '');
        text.setAttribute('font-size', '4');
      }
    });
    const smallText = await readSemantic(page);
    const smallest = Math.min(...smallText.classes.flatMap((box) => box.fonts));
    printSemantic('control.minfont', smallText);
    expect.soft(
      smallest,
      `control.minfont: dropping the font size must read below ${SEMANTIC_MIN_PC_PX}px; got ${formatNumber(smallest)}px`,
    ).toBeLessThan(SEMANTIC_MIN_PC_PX);
    await page.evaluate(() => {
      for (const text of document.querySelectorAll('.uml-node[data-entity-id] > text')) {
        const original = text.getAttribute('data-control-fontsize');
        if (original !== null && original !== '') text.setAttribute('font-size', original);
        else text.removeAttribute('font-size');
        text.removeAttribute('data-control-fontsize');
      }
    });

    // Arm 2 — the reserved tab band switched off: paint the tab over a class.
    await page.evaluate(() => {
      // Both the tab and the class must be ON SCREEN for the collision reading
      // to see them, so the target is the first class box whose painted rect
      // intersects the viewport.
      const onScreen = (rect: DOMRect): boolean =>
        rect.width > 0 && rect.height > 0 && rect.x < window.innerWidth && rect.x + rect.width > 0
        && rect.y < window.innerHeight && rect.y + rect.height > 0;
      const box = [...document.querySelectorAll('.uml-node[data-entity-id]')]
        .find((group) => onScreen(group.getBoundingClientRect()));
      const tab = [...document.querySelectorAll('.uml-package[data-package-id] > path')]
        .find((path) => onScreen(path.getBoundingClientRect()));
      if (tab === undefined || box === undefined || box === null) return;
      const destination = box.getBoundingClientRect();
      const origin = tab.getBoundingClientRect();
      tab.setAttribute('data-control-tab', tab.getAttribute('transform') ?? '');
      tab.setAttribute('transform', `translate(${destination.x - origin.x + 2}, ${destination.y - origin.y + 2})`);
    });
    const covered = await readSemantic(page);
    printSemantic('control.tab', covered);
    expect.soft(
      covered.tabOverlaps.length,
      `control.tab: a tab drawn over a class box must be read as covering it; overlaps=${JSON.stringify(covered.tabOverlaps)}`,
    ).toBeGreaterThan(0);
    await page.evaluate(() => {
      for (const tab of document.querySelectorAll('.uml-package[data-package-id] > path[data-control-tab]')) {
        const original = tab.getAttribute('data-control-tab');
        if (original !== null && original !== '') tab.setAttribute('transform', original);
        else tab.removeAttribute('transform');
        tab.removeAttribute('data-control-tab');
      }
    });

    // Arm 3 — endpoint following off: detach the last point from its frame.
    const attachedEdge = before.edges.find((edge) => edge.endpointOnFrame);
    await page.evaluate(({ source, target }) => {
      for (const group of document.querySelectorAll('.uml-edge[data-edge-source][data-edge-target]')) {
        if (group.getAttribute('data-edge-source') !== source) continue;
        if (group.getAttribute('data-edge-target') !== target) continue;
        group.setAttribute('data-control-edge-transform', group.getAttribute('transform') ?? '');
        group.setAttribute('transform', 'translate(80, 80)');
        break;
      }
    }, { source: attachedEdge?.source ?? '', target: attachedEdge?.target ?? '' });
    const detached = await readSemantic(page);
    printSemantic('control.endpoint', detached);
    expect.soft(
      detached.edges.some((edge) => !edge.endpointOnFrame),
      `control.endpoint: moving an endpoint off its frame must be read; edges=${JSON.stringify(detached.edges)}`,
    ).toBe(true);
    await page.evaluate(() => {
      for (const group of document.querySelectorAll('[data-control-edge-transform]')) {
        const original = group.getAttribute('data-control-edge-transform');
        if (original !== null && original !== '') group.setAttribute('transform', original);
        else group.removeAttribute('transform');
        group.removeAttribute('data-control-edge-transform');
      }
    });

    // Arm 4 — the monotone constraint off: swap two boxes on the same row.
    await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.uml-node[data-entity-id]')]
        .map((group) => ({ group, box: group.getBoundingClientRect() }))
        .filter((entry) => entry.box.width > 0
          && entry.box.x < window.innerWidth && entry.box.x + entry.box.width > 0
          && entry.box.y < window.innerHeight && entry.box.y + entry.box.height > 0);
      for (let left = 0; left < boxes.length; left += 1) {
        for (let right = left + 1; right < boxes.length; right += 1) {
          if (Math.abs(boxes[left].box.y - boxes[right].box.y) > 4) continue;
          if (Math.abs(boxes[left].box.x - boxes[right].box.x) < 8) continue;
          // Move the whole GROUPS (not just the rects): the painted box the
          // reading measures is the group's bounding box, which also includes
          // the compartment rules.
          const a = boxes[left].group;
          const b = boxes[right].group;
          const shift = boxes[right].box.x - boxes[left].box.x;
          a.setAttribute('data-control-transform', a.getAttribute('transform') ?? '');
          b.setAttribute('data-control-transform', b.getAttribute('transform') ?? '');
          a.setAttribute('transform', `translate(${shift}, 0)`);
          b.setAttribute('transform', `translate(${-shift}, 0)`);
          return;
        }
      }
    });
    const swapped = await readSemantic(page);
    printSemantic('control.order', swapped);
    // Compare through the SAME pair relation the main arm asserts, and require
    // at least one baseline pair to invert: a whole-array comparison would also
    // go red for a changed visible set, which is not the defect under test.
    const now = new Map(swapped.classes.map((box) => [box.id, box]));
    let inverted = 0;
    for (const row of baselineRows) {
      for (let left = 0; left < row.length; left += 1) {
        for (let right = left + 1; right < row.length; right += 1) {
          const a = now.get(row[left]);
          const b = now.get(row[right]);
          if (a === undefined || b === undefined) continue;
          if (Math.abs(a.centreY - b.centreY) > 6) continue;
          if (a.rect.x > b.rect.x) inverted += 1;
        }
      }
    }
    expect.soft(
      inverted,
      `control.order: swapping two same-row boxes must invert at least one pair; inverted=${inverted}`,
    ).toBeGreaterThan(0);
    await page.evaluate(() => {
      for (const group of document.querySelectorAll('[data-control-transform]')) {
        const original = group.getAttribute('data-control-transform');
        if (original !== null && original !== '') group.setAttribute('transform', original);
        else group.removeAttribute('transform');
        group.removeAttribute('data-control-transform');
      }
    });

    const restored = await readSemantic(page);
    printSemantic('control.restored', restored);
    assertSemantic(restored, 'control.restored', SEMANTIC_MIN_PC_PX, baselineRows);
  } finally {
    await context.close();
  }
});

/**
 * Control arm G: the phone zoom-cluster height guard, forced red.
 *
 * The main arm reads `zoomCluster.h` through the same `readLayout`; this arm
 * applies the shipped vertical column to the live cluster with `!important`
 * (the inline `flex-direction: row` must not win), then reads again. A guard
 * that could not go red on the defect it exists to catch would be vacuous.
 */
test('control arm G — a forced vertical zoom cluster reads taller than 52px on the phone', async ({ browser }) => {
  const { context, page } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PHONE,
    touch: true,
  });

  try {
    await openArchitectureTab(page, sessionId);
    const before = await readLayout(page);
    printReading('controlG.main', before);
    assertPhoneZoomClusterRow(before, 'controlG.main');

    await page.evaluate((sel) => {
      const cluster = document.querySelector<HTMLElement>(sel.zoomCluster);
      if (cluster === null) throw new Error('the phone zoom cluster must be on screen');
      // The shipped arrangement: a column of 44px controls reaching up the
      // drawing's right edge. `important` is what makes the injection real —
      // the component states `flex-direction: row` inline.
      cluster.style.setProperty('flex-direction', 'column', 'important');
      cluster.style.setProperty('height', 'auto', 'important');
    }, SEL);
    await settle(page, 150);

    const injected = await readLayout(page);
    printReading('controlG.vertical', injected);
    expect.soft(
      injected.zoomCluster?.h ?? 0,
      'controlG.vertical: a vertical cluster must read taller than the 52px row — '
        + `cluster=${formatBox(injected.zoomCluster)}`,
    ).toBeGreaterThan(52);
  } finally {
    await context.close();
  }
});

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

/**
 * Control arm C: the shipped clipping, injected.
 *
 * `overflow-x: auto` on the toolbar ALSO makes the block axis a scroll
 * container, which is exactly how the search results were clipped to their
 * first 3px; `height: 39px` reproduces the measured toolbar row. The style is
 * injected into the live toolbar, and the SAME {@link readSearch} function is
 * asserted on both sides: usable before, clipped with the style, usable again
 * once it is removed.
 */
test('control arm C — a scrolling toolbar clips the search result list', async ({ browser }) => {
  const { context, page } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PC,
    touch: false,
  });

  try {
    await openArchitectureTab(page, sessionId);
    // A stem shared by many drawn entities, so the list is tall enough to have a
    // meaningful visible centre (one row would make the reading vacuous).
    const searchQuery = 'Stage';
    await page.locator(SEL.search).first().fill(searchQuery);
    await expect(page.locator(SEL.searchResults).first()).toBeVisible({ timeout: 10_000 });

    const before = await readSearch(page);
    console.log(`[architecture-layout] controlC.before=${JSON.stringify(before)}`);
    assertSearchUsable(before, 'controlC.before');

    const injected = await page.evaluate((sel) => {
      const toolbar = document.querySelector(sel.toolbar);
      if (!(toolbar instanceof HTMLElement)) return null;
      const previous = toolbar.style.cssText;
      // The shipped shape: a horizontal scroller whose block axis scrolls too.
      toolbar.style.overflowX = 'auto';
      toolbar.style.overflowY = 'auto';
      toolbar.style.height = '39px';
      return { previous };
    }, SEL);
    console.log(`[architecture-layout] controlC.injected=${injected !== null}`);
    expect(injected, 'the toolbar must be on screen').not.toBeNull();
    await settle(page, 400);

    const clipped = await readSearch(page);
    console.log(`[architecture-layout] controlC.clipped=${JSON.stringify(clipped)}`);
    expect.soft(
      clipped.visibleHeight,
      `control arm C: a scrolling toolbar must clip the result list — `
        + `visible height ${formatNumber(clipped.visibleHeight)}px must be < ${SEARCH_RESULT_MIN_VISIBLE_PX}px; `
        + `results=${formatBox(clipped.results)}`,
    ).toBeLessThan(SEARCH_RESULT_MIN_VISIBLE_PX);

    await page.evaluate((sel) => {
      const toolbar = document.querySelector(sel.toolbar);
      if (toolbar instanceof HTMLElement) toolbar.style.cssText = '';
    }, SEL);
    await settle(page, 400);

    const restored = await readSearch(page);
    console.log(`[architecture-layout] controlC.restored=${JSON.stringify(restored)}`);
    assertSearchUsable(restored, 'controlC.restored');
  } finally {
    await context.close();
  }
});

/**
 * Control arm E: the selection guard's own false.
 *
 * The main arm reads 0 characters after a drag. A reading that can only ever
 * report 0 proves nothing, so this arm switches the drawing's policy back to
 * `user-select: auto` on the SAME page and repeats the SAME drag through the
 * SAME {@link readTextSelection}: the reading must land above 0. The policy is
 * restored afterwards and the drag must return to 0 — the three readings differ
 * only in the injected style.
 *
 * The press guard reads the pressed element's computed policy, so it stands
 * down for a canvas declared selectable; that is what lets this arm see the
 * browser select text instead of a second layer refusing it.
 */
test('control arm E — a canvas switched back to user-select: auto selects text', async ({ browser }) => {
  const { context, page } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PC,
    touch: false,
  });

  try {
    await openArchitectureTab(page, sessionId);

    const points = await findGesturePoints(page);
    const label = points.label as GesturePoint | null;
    expect(label, 'control arm E: the drawing must offer a node label to drag from').not.toBeNull();
    const from = label as GesturePoint;
    const to = { x: from.x + 140, y: from.y + 70 };

    // The baseline: the shipped policy leaves no selection.
    await clearTextSelection(page);
    await dragAcross(page, from, to);
    await settle(page, 200);
    const before = await readTextSelection(page);
    console.log(`[architecture-layout] controlE.before=${JSON.stringify(before)}`);
    expect(before.length, 'control arm E baseline: the shipped drawing must not select').toBe(0);

    // The shipped defect, injected: the canvas — the region, the host, the SVG
    // and every label in it — is declared selectable. The REGION is included
    // because `user-select: auto` resolves to the parent's used value, so a
    // child left auto under a still-`none` ancestor would still be unselectable
    // and the arm would prove nothing.
    const injected = await page.evaluate((sel) => {
      const host = document.querySelector(sel.host) as HTMLElement | null;
      if (host === null) return null;
      const region = host.closest('[data-architecture-canvas-region]') ?? host;
      const targets: Element[] = [region, ...region.querySelectorAll('*')];
      for (const element of targets) {
        (element as SVGElement | HTMLElement).style.setProperty('user-select', 'auto', 'important');
        (element as SVGElement | HTMLElement).style.setProperty('-webkit-user-select', 'auto', 'important');
      }
      return { count: targets.length };
    }, SEL);
    console.log(`[architecture-layout] controlE.injected=${JSON.stringify(injected?.count ?? null)}`);
    expect(injected, 'the drawing host must be on screen').not.toBeNull();
    await settle(page, 200);

    await clearTextSelection(page);
    await dragAcross(page, from, to);
    await settle(page, 200);
    const selected = await readTextSelection(page);
    console.log(`[architecture-layout] controlE.injected-reading=${JSON.stringify(selected)}`);
    expect(
      selected.length,
      `control arm E: a canvas declared user-select: auto must select text; `
        + `the same drag selected ${selected.length} characters`,
    ).toBeGreaterThan(0);

    // Restore the shipped policy exactly, then the same drag reads 0 again.
    await page.evaluate((sel) => {
      const host = document.querySelector(sel.host) as HTMLElement | null;
      if (host === null) return;
      const region = host.closest('[data-architecture-canvas-region]') ?? host;
      for (const element of [region, ...region.querySelectorAll('*')]) {
        const style = (element as SVGElement | HTMLElement).style;
        style.removeProperty('user-select');
        style.removeProperty('-webkit-user-select');
      }
      // Re-state the shipped declarations the injection overwrote.
      for (const element of [region, host, ...host.querySelectorAll('svg, text, tspan')]) {
        (element as SVGElement | HTMLElement).style.userSelect = 'none';
      }
    }, SEL);
    await clearTextSelection(page);
    await dragAcross(page, from, to);
    await settle(page, 200);
    const restored = await readTextSelection(page);
    console.log(`[architecture-layout] controlE.restored=${JSON.stringify(restored)}`);
    expect(restored.length, 'control arm E: the restored canvas must not select').toBe(0);
  } finally {
    await context.close();
  }
});
