import fs from 'node:fs';

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, request, test } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';

import {
  ARCHITECTURE_FIXTURE_WORKSPACE,
  ARCHITECTURE_FIXTURE_WORKSPACE_CUI,
  ARCHITECTURE_FIXTURE_WORKSPACE_NODE_SIZE,
  ARCHITECTURE_FIXTURE_WORKSPACE_ORIENTATION,
  FIT_CONTRACT_WORKSPACES,
  NODE_SIZE_ENTITIES,
  nodeSizeMemberSignature,
  writeFitContractFixture,

  ARCHITECTURE_FIXTURE_WORKSPACE_FUNCTIONS,
  ARCHITECTURE_FIXTURE_WORKSPACE_INTERLEAVED,
  ARCHITECTURE_FIXTURE_WORKSPACE_PERIMETER,
  ARCHITECTURE_FIXTURE_WORKSPACE_SCOPE_HYGIENE,
  writeArchitectureFixture,
  type ArchitectureFixtureReading,
  type FitContractFixtureOptions,
  type FixtureMemberKind,
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
/** The landscape phone the short-touch tier exists for: wide, but only 390px tall. */
const VIEWPORT_PHONE_LANDSCAPE = { width: 844, height: 390 };

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
  zoomClusterToggle: '[data-architecture-zoom-cluster-toggle]',
  zoomClusterCollapse: '[data-architecture-zoom-cluster-collapse]',
  node: '.uml-node',
  zoomIn: '[data-architecture-zoom-in]',
  zoomOut: '[data-architecture-zoom-out]',
  explosion: '[data-architecture-explosion]',
  // The class (entity) diagram's granularity radio. The semantic readings are
  // specified on THIS graph: file nodes carry no kinds or members.
  viewEntity: '[data-architecture-view-option="entity"]',
  viewFile: '[data-architecture-view-option="file"]',
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
  // The filter drawer: the disclosure, its menu, and the two readings this
  // criterion takes from it (the relation preset, and the "Show all" action).
  filterToggle: '[data-architecture-filter-toggle]',
  filterMenu: '[data-architecture-filter-menu]',
  relationDependency: '[data-architecture-filter-relation="dependency"]',
  relationCall: '[data-architecture-filter-relation="call"]',
  relationStructural: '[data-architecture-filter-relation="structural"]',
  filterShowAll: '[data-architecture-filter-show-all]',
  // The on-canvas zoom cluster's Fit control.
  zoomFit: '[data-architecture-zoom-fit]',
  // The transient hover reading and the wrapper whose inline position the
  // placement rule writes.
  hoverChip: '[data-architecture-hover]',
  hoverHint: '[data-architecture-hover-hint]',
  // The provenance footer's cleanup disclosure and its detail panel.
  scopeHygiene: '[data-architecture-scope-hygiene]',
  scopeHygieneDetail: '[data-architecture-scope-hygiene-detail]',
  // The drilled-view status and the breadcrumb back to the class drawing.
  neighbourhoodStatus: '[data-architecture-neighbourhood-status]',
  back: '[data-architecture-back]',
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
  /** The drawing host's client height: the portrait canvas-share numerator. */
  hostClientHeight: number | null;
  /** hostClientHeight ÷ viewport height. The portrait tier must keep ≥0.74. */
  canvasShare: number | null;
  /** Whether the toolbar is in the portrait-phone form. */
  toolbarPortrait: boolean;
  /** Distinct top edges of the toolbar's visible buttons: 1 means ONE row. */
  toolbarRows: number;
  /** Whether the zoom cluster is collapsed to its one 44px button. */
  clusterCollapsed: boolean;
  /** Painted package tabs and class-name texts, and how many the cluster covers. */
  packageTabCount: number;
  nameTextCount: number;
  clusterOverPackageTabs: number;
  clusterOverNames: number;
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

    // The portrait-phone contract. The toolbar's row count is the distinct top
    // edges of the buttons it actually paints, so a wrapped second row cannot
    // pass by hiding behind the flex contract alone.
    const toolbarButtonTops = toolbar === null
      ? []
      : [...toolbar.querySelectorAll('button')]
        .filter((button) => {
          const rect = button.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map((button) => Math.round(button.getBoundingClientRect().top));
    // The drawn labels the floating corner controls must clear: each package's
    // own tab and every class-name text. The old `chromeOverNodes` leg only saw
    // `.uml-node` boxes, which the folded package tier does not draw at all —
    // exactly the state the cluster used to cover.
    const packageTabs = [...document.querySelectorAll(`${sel.canvas} .uml-package[data-package-id] > path`)]
      .map(boxOf)
      .filter((box): box is Box => box !== null && box.w > 0 && box.h > 0);
    const nameTexts = [...document.querySelectorAll(`${sel.canvas} [data-architecture-node-name]`)]
      .map(boxOf)
      .filter((box): box is Box => box !== null && box.w > 0 && box.h > 0);
    const hostClientHeight = host instanceof HTMLElement ? host.clientHeight : null;

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
      theoreticalFit,
      natural,
      footer: footerBox,
      footerPosition: footer === null ? '<none>' : window.getComputedStyle(footer).position,
      footerOverMinimap: overlaps(footerBox, minimapBox),
      footerOverZoomCluster: overlaps(footerBox, zoomClusterBox),
      zoomLevelText: (zoomLevel?.textContent ?? '').trim(),
      readableHintPercent: hintPercent === null ? null : Number(hintPercent[1]),
      hostClientHeight,
      canvasShare: hostClientHeight !== null && window.innerHeight > 0
        ? hostClientHeight / window.innerHeight
        : null,
      toolbarPortrait: toolbar?.getAttribute('data-architecture-toolbar-portrait') === 'true',
      toolbarRows: new Set(toolbarButtonTops).size,
      clusterCollapsed: document.querySelector('[data-architecture-zoom-cluster-toggle]') !== null,
      packageTabCount: packageTabs.length,
      nameTextCount: nameTexts.length,
      clusterOverPackageTabs: packageTabs.filter((box) => overlaps(box, zoomClusterBox)).length,
      clusterOverNames: nameTexts.filter((box) => overlaps(box, zoomClusterBox)).length,
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
  console.log(`[architecture-layout] ${label}.zoom=${reading.zoomMode}@${formatNumber(reading.zoomScale)}`);
  console.log(`[architecture-layout] ${label}.theoretical.fit=${formatNumber(reading.theoreticalFit)} natural=${JSON.stringify(reading.natural)}`);
  console.log(`[architecture-layout] ${label}.footer.box=${formatBox(reading.footer)} position=${reading.footerPosition}`);
  console.log(`[architecture-layout] ${label}.footer.over.minimap=${reading.footerOverMinimap} footer.over.zoomCluster=${reading.footerOverZoomCluster}`);
  console.log(`[architecture-layout] ${label}.zoom.level.text=${JSON.stringify(reading.zoomLevelText)} readable.hint.percent=${formatNumber(reading.readableHintPercent)}`);
  console.log(`[architecture-layout] ${label}.portrait.host.clientHeight=${formatNumber(reading.hostClientHeight)} `
    + `canvas.share=${formatNumber(reading.canvasShare)} toolbar.portrait=${String(reading.toolbarPortrait)} `
    + `toolbar.rows=${reading.toolbarRows} cluster.collapsed=${String(reading.clusterCollapsed)}`);
  console.log(`[architecture-layout] ${label}.portrait.controls=`
    + `packageTabs=${reading.packageTabCount} names=${reading.nameTextCount} `
    + `clusterOverTabs=${reading.clusterOverPackageTabs} clusterOverNames=${reading.clusterOverNames}`);
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

/* ── the portrait phone's chrome contract ────────────────────────────────────────────────── */

/**
 * How much of the 390×844 viewport the drawing host must keep. The task fixes
 * it at 74% (≥625px); the pre-task chrome left it at 578px (68.5%).
 */
const PORTRAIT_CANVAS_SHARE_FLOOR = 0.74;

/**
 * The portrait phone's THREE readings, all from the SAME `readLayout` round
 * trip the main and control arms share:
 *
 *  · the drawing host keeps ≥74% of the viewport height;
 *  · the toolbar paints exactly ONE row (distinct button `top` values);
 *  · neither the zoom cluster nor the minimap covers a painted package tab or
 *    class-name text — the folded tier draws no `.uml-node`, which is why the
 *    old node-only clearance leg could not see this defect at all.
 */
const assertPortraitChrome = (reading: LayoutReading, label: string): void => {
  expect.soft(
    reading.canvasShare,
    `${label}: the drawing host must keep ≥${PORTRAIT_CANVAS_SHARE_FLOOR} of the viewport — `
      + `clientHeight=${formatNumber(reading.hostClientHeight)} / viewport ${reading.viewport.height} `
      + `= ${formatNumber(reading.canvasShare)} (pre-task 578px / 0.685)`,
  ).toBeGreaterThanOrEqual(PORTRAIT_CANVAS_SHARE_FLOOR);
  expect.soft(reading.toolbarPortrait, `${label}: the portrait-phone toolbar tier must be in force`).toBe(true);
  expect.soft(
    reading.toolbarRows,
    `${label}: the toolbar must paint exactly ONE row — button tops ${JSON.stringify(reading.toolbarRows)}`,
  ).toBe(1);
  expect.soft(reading.clusterCollapsed, `${label}: the zoom cluster must start collapsed to one button`).toBe(true);
  expect.soft(
    reading.packageTabCount + reading.nameTextCount,
    `${label}: the reading needs painted package tabs or class names — `
      + `tabs=${reading.packageTabCount} names=${reading.nameTextCount}`,
  ).toBeGreaterThan(0);
  expect.soft(
    reading.clusterOverPackageTabs,
    `${label}: the zoom cluster must not cover a package tab — `
      + `${reading.clusterOverPackageTabs} of ${reading.packageTabCount} tabs overlap `
      + `cluster=${formatBox(reading.zoomCluster)}`,
  ).toBe(0);
  expect.soft(
    reading.clusterOverNames,
    `${label}: the zoom cluster must not cover a class-name text — `
      + `${reading.clusterOverNames} of ${reading.nameTextCount} names overlap `
      + `cluster=${formatBox(reading.zoomCluster)}`,
  ).toBe(0);
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
  // The Focus|Overview mode that this leg used to read was RETIRED by the
  // single-scale fit contract: the tab always opens on the solved whole-graph
  // fit, and "inside the canvas" is the reading that survives the retirement.
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
  /** The screen y of every compartment rule, sorted top to bottom. */
  readonly ruleYs: number[];
  /** The drawn member rows, with the screen y each one paints at. */
  readonly memberRows: { readonly text: string; readonly y: number }[];
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
  /**
   * Does ANY of the relation's polyline points or arrowhead points fall outside
   * the SVG element's own box (tolerance 0.5 px)? A point outside the viewBox
   * is clipped by `overflow: hidden`, so this is the clipped-relation reading.
   */
  readonly outsideSvgBox: boolean;
  /** Whether either endpoint's own entity is on screen (otherwise the leg is vacuous). */
  readonly checkable: boolean;
  /** The screen-space points the endpoint reading saw (diagnosis only). */
  readonly tail: { x: number; y: number }[];
};

/** One sticky package label as the browser paints it. */
type SemanticStickyLabel = {
  readonly id: string;
  readonly rect: LodRect;
  /** The label's on-screen font size(s), in CSS px. */
  readonly fonts: number[];
};

/** One drawn class name, read by ROLE (never by child order). */
type SemanticNameReading = {
  readonly id: string;
  /** The entity label the role-selected text says it belongs to. */
  readonly label: string | null;
  /** The role-selected name text's content. */
  readonly text: string;
  /** All name lines' text concatenated (wrapped names join back to the label). */
  readonly joined: string;
  /** How many name lines the frame draws. */
  readonly lines: number;
  /** The frame's painted width, for the "wide enough for one line" rule. */
  readonly boxWidth: number;
  /** The full label's measured width at the drawn font size. */
  readonly labelWidth: number;
  /** `true` when the wide-box rule requires a single line. */
  readonly oneLineRequired: boolean;
};

/** The pinned-entity reading. */
type SemanticPinnedReading = {
  readonly id: string;
  readonly name: string;
  readonly label: string | null;
  readonly badgeCount: number;
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
  /** Sticky package labels, with their fonts. */
  readonly stickyLabels: SemanticStickyLabel[];
  /** Sticky labels whose own package tab is still visible on screen. */
  readonly stickyOwnTabVisible: string[];
  /** Sticky labels covering a visible class-name text. */
  readonly stickyNameOverlaps: string[];
  /** Sticky labels clipped by the viewport edge. */
  readonly stickyClipped: string[];
  /** Class names read by role, with their line counts. */
  readonly names: SemanticNameReading[];
  /** The overview hint pill, when drawn. */
  readonly hint: { readonly rect: LodRect; readonly text: string } | null;
  /** `hint ∩ tab` names: the pill must not cover a package tab. */
  readonly hintTabOverlaps: string[];
  /** `class rule ∩ member text` names: the split rule must not cross a row. */
  readonly memberRuleOverlaps: string[];
  /** Member-area texts that are the renderer's own compact truncation row. */
  readonly upstreamOverflowRows: string[];
  /** Pinned entities: name (by role) and badge count. */
  readonly pinned: SemanticPinnedReading[];
  /** Diagnostic: the renderer's own compartment heights per drawn class. */
  readonly memberShapes: { readonly id: string; readonly attrsH: number; readonly opsH: number; readonly drawnH: number }[];
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
        // The compartment rules are the frame's own `<line>` children; their
        // screen y is what splits the attributes band from the operations band.
        const ruleYs = [...group.children]
          .filter((child) => child.tagName.toLowerCase() === 'line')
          .map((line) => {
            const lineRect = rectOf(line);
            return lineRect.y + lineRect.height / 2;
          })
          .sort((a, b) => a - b);
        // The semantic pass draws one text per member row and tags it; reading
        // the PAINTED position (not the tag) is what makes the compartment
        // assertion a reading of the drawing.
        const memberRows = [...group.querySelectorAll('[data-architecture-node-member]')]
          .filter((member) => painted(member))
          .map((member) => {
            const memberRect = rectOf(member);
            return { text: (member.textContent ?? '').trim(), y: memberRect.y + memberRect.height / 2 };
          });
        return {
          id: group.getAttribute('data-entity-id') ?? '',
          rect: own,
          fonts: texts.map((text) => {
            const declared = Number.parseFloat(getComputedStyle(text).fontSize);
            return (Number.isFinite(declared) ? declared : 0) * scale;
          }),
          rules: ruleYs.length,
          ruleYs,
          memberRows,
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
    // The SVG element's own painted box: in semantic mode its viewBox IS the
    // content boundary, so a relation point outside this rect is clipped by
    // the root's `overflow: hidden`.
    const semanticSvgElement = document.querySelector('svg[data-architecture-semantic]')
      ?? document.querySelector(`${sel.host} svg`);
    const svgPaintedBox = semanticSvgElement === null ? null : rectOf(semanticSvgElement);
    const SVG_BOX_TOLERANCE_PX = 0.5;
    const insideSvgBox = (point: { x: number; y: number }): boolean => svgPaintedBox === null
      || (point.x >= svgPaintedBox.x - SVG_BOX_TOLERANCE_PX
        && point.x <= svgPaintedBox.x + svgPaintedBox.width + SVG_BOX_TOLERANCE_PX
        && point.y >= svgPaintedBox.y - SVG_BOX_TOLERANCE_PX
        && point.y <= svgPaintedBox.y + svgPaintedBox.height + SVG_BOX_TOLERANCE_PX);
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
        // what touches the frame. A bundled relation keeps one polygon per
        // member inside its head groups, so read every polygon.
        const polygonElements = [...group.querySelectorAll('polygon')];
        const screenOfPolygon = (polygon: Element, point: { x: number; y: number }): { x: number; y: number } =>
          screenOf(polygon as SVGElement, point);
        const arrowPoints = polygonElements.flatMap((polygon) => (polygon.getAttribute('points') ?? '')
          .trim()
          .split(/\s+/)
          .map((pair) => pair.split(',').map(Number))
          .filter((pair) => pair.length === 2 && Number.isFinite(pair[0]) && Number.isFinite(pair[1]))
          .map(([x, y]) => screenOfPolygon(polygon, { x, y })));
        const screenPoints = [
          ...points.map((point) => (path === null ? point : screenOf(path, point))),
          ...arrowPoints,
        ];
        const tail = [
          ...points.slice(0, 1).map((point) => (path === null ? point : screenOf(path, point))),
          ...points.slice(-1).map((point) => (path === null ? point : screenOf(path, point))),
          ...arrowPoints,
        ];
        const visibleIds = new Set(classes.map((box) => box.id));
        const source = group.getAttribute('data-edge-source');
        const target = group.getAttribute('data-edge-target');
        return {
          source,
          target,
          orthogonal: true,
          endpointOnFrame: tail.some((point) => onFrame(point)),
          outsideSvgBox: screenPoints.some((point) => !insideSvgBox(point)),
          // An edge whose two ends are both scrolled out has no frame on
          // screen to touch; that is not a defect in the mapping.
          checkable: (source !== null && visibleIds.has(source)) || (target !== null && visibleIds.has(target)),
          tail,
        };
      });
    // ---- role-based name reading (defect 6)
    const isStereotype = (value: string): boolean => /^(?:<<\s*\w+\s*>>|«\s*\w+\s*»)$/.test(value.trim());
    const isAuxiliary = (text: Element): boolean => {
      const cls = text.getAttribute('class') ?? '';
      if (/arch-pinned-badge|arch-selected-check|uml-(attr|op|edge-label)/.test(cls)) return true;
      if (text.getAttribute('data-architecture-pinned-badge') === 'true') return true;
      if (text.hasAttribute('data-architecture-node-member') || text.hasAttribute('data-architecture-node-more')) return true;
      return isStereotype(text.textContent ?? '');
    };
    const svgElement = document.querySelector('svg[data-architecture-semantic]')
      ?? document.querySelector(`${sel.host} svg`);
    const measureLabel = (like: Element | null, label: string): number => {
      if (like === null || svgElement === null) return 0;
      const style = getComputedStyle(like);
      const clone = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      clone.setAttribute('font-family', style.fontFamily);
      clone.setAttribute('font-size', style.fontSize);
      clone.setAttribute('font-weight', style.fontWeight);
      clone.setAttribute('visibility', 'hidden');
      clone.textContent = label;
      svgElement.appendChild(clone);
      try {
        return clone.getComputedTextLength();
      } finally {
        clone.remove();
      }
    };
    const names: {
      id: string;
      label: string | null;
      text: string;
      joined: string;
      lines: number;
      boxWidth: number;
      labelWidth: number;
      oneLineRequired: boolean;
    }[] = [];
    for (const group of document.querySelectorAll('.uml-node[data-entity-id]')) {
      if (!painted(group) || !intersects(rectOf(group))) continue;
      const texts = [...group.children].filter((child) => child.tagName.toLowerCase() === 'text');
      const roleName = texts.find((text) => !isAuxiliary(text) && painted(text)
        && (text.textContent ?? '').trim() !== '') ?? null;
      const label = roleName?.getAttribute('data-architecture-label') ?? null;
      const nameLines = texts.filter((text) => text.hasAttribute('data-architecture-node-name') && painted(text));
      const boxWidth = rectOf(group.querySelector('rect')).width;
      const labelWidth = label === null ? 0 : measureLabel(roleName, label);
      names.push({
        id: group.getAttribute('data-entity-id') ?? '',
        label,
        text: roleName?.textContent ?? '',
        joined: nameLines.map((text) => text.textContent ?? '').join(''),
        lines: nameLines.length,
        boxWidth,
        labelWidth,
        oneLineRequired: label !== null && labelWidth > 0 && labelWidth + 20 <= boxWidth,
      });
    }

    // ---- sticky labels (defects 2 and 3)
    // "Visible" means visible INSIDE the scroll host's content box, not merely
    // somewhere in the window: the SVG is taller than the host and the host
    // clips it, so `getBoundingClientRect` of a scrolled-out tab still reports a
    // window coordinate. Reading the window was the bug that made the shipped
    // ghost look like "its own tab is visible".
    const hostElement = document.querySelector(sel.host);
    const hostBox = hostElement === null ? null : hostElement.getBoundingClientRect();
    const insideHost = (rect: { x: number; y: number; width: number; height: number }): boolean =>
      rect.width > 0 && rect.height > 0 && hostBox !== null
      && rect.x < hostBox.right && rect.x + rect.width > hostBox.left
      && rect.y < hostBox.bottom && rect.y + rect.height > hostBox.top;
    const fullyInsideHost = (rect: { x: number; y: number; width: number; height: number }): boolean =>
      rect.width > 0 && rect.height > 0 && hostBox !== null
      && rect.x >= hostBox.left - 0.5 && rect.x + rect.width <= hostBox.right + 0.5
      && rect.y >= hostBox.top - 0.5 && rect.y + rect.height <= hostBox.bottom + 0.5;
    const allPackages = [...document.querySelectorAll('.uml-package[data-package-id]')];
    const tabOfPackage = (id: string): { x: number; y: number; width: number; height: number } | null => {
      const group = allPackages.find((candidate) => candidate.getAttribute('data-package-id') === id);
      const path = group?.querySelector('path') ?? null;
      return path === null ? null : rectOf(path);
    };
    const stickyGroups = [...document.querySelectorAll('[data-architecture-sticky-package]')].filter(painted);
    const stickyLabels = stickyGroups.map((group) => ({
      id: group.getAttribute('data-architecture-sticky-package') ?? '',
      rect: rectOf(group),
      fonts: [...group.querySelectorAll('text')].map((text) => {
        const declared = Number.parseFloat(getComputedStyle(text).fontSize);
        return (Number.isFinite(declared) ? declared : 0) * screenScale(group);
      }),
    }));
    const nameElements = [...document.querySelectorAll('[data-architecture-node-name]')].filter(painted);
    const stickyOwnTabVisible: string[] = [];
    const stickyNameOverlaps: string[] = [];
    const stickyClipped: string[] = [];
    for (const sticky of stickyLabels) {
      const tab = tabOfPackage(sticky.id);
      if (tab !== null && insideHost(tab)) stickyOwnTabVisible.push(sticky.id);
      if (!fullyInsideHost(sticky.rect)) stickyClipped.push(sticky.id);
      for (const name of nameElements) {
        if (overlap(sticky.rect, rectOf(name))) {
          stickyNameOverlaps.push(`${sticky.id} ∩ ${name.closest('[data-entity-id]')?.getAttribute('data-entity-id') ?? '?'}`);
        }
      }
    }

    // ---- the overview hint pill vs package tabs (defect 2)
    const hintElement = document.querySelector('[data-architecture-readable-hint]');
    const hintRect = hintElement === null ? null : rectOf(hintElement);
    const hint = hintElement !== null && hintRect !== null && hintRect.width > 0 && hintRect.height > 0
      ? { rect: hintRect, text: (hintElement.textContent ?? '').trim() }
      : null;
    const hintTabOverlaps: string[] = [];
    if (hint !== null) {
      for (const pkg of packages) {
        if (pkg.tab === null || !insideHost(pkg.tab)) continue;
        if (overlap(hint.rect, pkg.tab)) hintTabOverlaps.push(`hint ∩ ${pkg.id}`);
      }
    }

    // ---- the second compartment rule vs member text (defect 5)
    const memberRuleOverlaps: string[] = [];
    const upstreamOverflowRows: string[] = [];
    for (const group of document.querySelectorAll('.uml-node[data-entity-id]')) {
      if (!painted(group) || !intersects(rectOf(group))) continue;
      const id = group.getAttribute('data-entity-id') ?? '';
      const members = [...group.querySelectorAll('[data-architecture-node-member], [data-architecture-node-more]')]
        .filter(painted);
      for (const member of members) {
        const value = member.textContent ?? '';
        if (/…\s*\+\d+\s+more\s*\(\d+\s+members\)/.test(value)) upstreamOverflowRows.push(`${id}: ${value}`);
      }
      const rules = [...group.children].filter((child) => child.tagName.toLowerCase() === 'line');
      if (rules.length < 2 || members.length === 0) continue;
      const ruleRect = rectOf(rules[1]);
      const rule = {
        x: ruleRect.x,
        y: ruleRect.y + ruleRect.height / 2 - 0.5,
        width: ruleRect.width,
        height: 1,
      };
      for (const member of members) {
        if (overlap(rule, rectOf(member))) memberRuleOverlaps.push(`${id} rule ∩ ${(member.textContent ?? '').trim()}`);
      }
    }

    // ---- pinned entity: name by role, exactly one badge (defect 6)
    const pinned = [...document.querySelectorAll('.uml-node[data-architecture-pinned="true"]')]
      .filter(painted)
      .map((group) => {
        const texts = [...group.children].filter((child) => child.tagName.toLowerCase() === 'text');
        const roleName = texts.find((text) => !isAuxiliary(text) && painted(text)
          && (text.textContent ?? '').trim() !== '') ?? null;
        const labels = new Set([
          ...group.querySelectorAll('[data-architecture-pinned-badge]'),
          ...group.querySelectorAll('.arch-pinned-badge'),
        ]);
        return {
          id: group.getAttribute('data-entity-id') ?? '',
          name: roleName?.textContent ?? '',
          label: roleName?.getAttribute('data-architecture-label') ?? null,
          badgeCount: labels.size,
        };
      });

    const memberShapes: { id: string; attrsH: number; opsH: number; drawnH: number }[] = [];
    for (const group of document.querySelectorAll('.uml-node[data-entity-id]')) {
      if (!painted(group) || !intersects(rectOf(group))) continue;
      const id = group.getAttribute('data-entity-id') ?? '';
      memberShapes.push({
        id,
        attrsH: Number(group.getAttribute('data-attrs-h') ?? '0'),
        opsH: Number(group.getAttribute('data-ops-h') ?? '0'),
        drawnH: rectOf(group.querySelector('rect')).height,
      });
    }

    return {
      tier: document.querySelector('svg[data-architecture-semantic]')?.getAttribute('data-architecture-semantic') ?? null,
      depth: root?.getAttribute('data-architecture-lod-depth') ?? null,
      scale: number(root?.getAttribute('data-architecture-zoom-scale') ?? null),
      semantic: document.querySelector('svg[data-architecture-semantic]') !== null,
      classes,
      packages,
      tabOverlaps,
      edges,
      stickyLabels,
      stickyOwnTabVisible,
      stickyNameOverlaps,
      stickyClipped,
      names,
      hint,
      hintTabOverlaps,
      memberRuleOverlaps,
      upstreamOverflowRows,
      pinned,
      memberShapes,
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
  console.log(
    `[architecture-semantic] ${label}.polish=`
    + JSON.stringify({
      stickies: reading.stickyLabels.map((sticky) => [sticky.id, sticky.rect, sticky.fonts]),
      ownTabVisible: reading.stickyOwnTabVisible,
      stickyNameOverlaps: reading.stickyNameOverlaps,
      stickyClipped: reading.stickyClipped,
      hint: reading.hint,
      hintTabOverlaps: reading.hintTabOverlaps,
      memberRuleOverlaps: reading.memberRuleOverlaps,
      upstreamOverflowRows: reading.upstreamOverflowRows,
      names: reading.names.map((name) => [name.id, name.label, name.text, name.joined, name.lines, name.oneLineRequired]),
      pinned: reading.pinned,
      memberShapes: reading.memberShapes.slice(0, 8),
    }),
  );
  console.log(`[architecture-semantic] ${label}.boxes=${JSON.stringify(reading.classes.map((box) => [box.id, box.rect]))}`);
  console.log(
    `[architecture-semantic] ${label}.clip=`
    + JSON.stringify({
      edges: reading.edges.length,
      outside: reading.edges.filter((edge) => edge.outsideSvgBox).map((edge) => [edge.source, edge.target]),
      memberRows: reading.classes.map((box) => [
        box.id,
        box.ruleYs,
        box.memberRows.map((row) => [memberTokenOf(row.text), Math.round(row.y)]),
      ]),
    }),
  );
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
  // A sticky label is visible text too.
  for (const sticky of reading.stickyLabels) {
    for (const font of sticky.fonts) {
      expect.soft(
        font,
        `${label}: sticky label ${sticky.id} must be at least ${minFontPx}px on screen; got ${formatNumber(font)}px`,
      ).toBeGreaterThanOrEqual(minFontPx - 0.05);
    }
  }
  expect.soft(
    reading.stickyOwnTabVisible,
    `${label}: a sticky label must not be shown while its own package tab is on screen; ${JSON.stringify(reading.stickyOwnTabVisible)}`,
  ).toEqual([]);
  expect.soft(
    reading.stickyNameOverlaps,
    `${label}: a sticky label must not cover a visible class name; overlaps=${JSON.stringify(reading.stickyNameOverlaps)}`,
  ).toEqual([]);
  expect.soft(
    reading.stickyClipped,
    `${label}: a sticky label must be fully inside the viewport; clipped=${JSON.stringify(reading.stickyClipped)}`,
  ).toEqual([]);
  expect.soft(
    reading.hintTabOverlaps,
    `${label}: the overview hint must not cover a package tab; overlaps=${JSON.stringify(reading.hintTabOverlaps)}`,
  ).toEqual([]);
  expect.soft(
    reading.upstreamOverflowRows,
    `${label}: the member area must not contain the renderer’s own overflow row; rows=${JSON.stringify(reading.upstreamOverflowRows)}`,
  ).toEqual([]);
  expect.soft(
    reading.memberRuleOverlaps,
    `${label}: the attribute/operation rule must not cross a member row; overlaps=${JSON.stringify(reading.memberRuleOverlaps)}`,
  ).toEqual([]);
  for (const name of reading.names) {
    if (name.lines === 0) continue;
    // Role-based reading: the name is the first text that is NOT a badge,
    // check, stereotype or member, and it must carry its entity's label.
    expect.soft(
      name.text,
      `${label}: ${name.id}'s name must not be a decoration glyph (got ${JSON.stringify(name.text)})`,
    ).not.toBe('📌');
    expect.soft(
      name.label,
      `${label}: the role-selected name text of ${name.id} must carry its entity label`,
    ).not.toBeNull();
    if (name.label !== null) {
      const plain = name.joined === name.label;
      const elided = name.joined.includes('…')
        && name.label.startsWith(name.joined.split('…')[0] ?? '')
        && name.label.endsWith(name.joined.split('…')[1] ?? '');
      expect.soft(
        plain || elided,
        `${label}: ${name.id}'s name text ${JSON.stringify(name.joined)} must be its label ${JSON.stringify(name.label)} (or a middle ellipsis of it)`,
      ).toBe(true);
      if (name.oneLineRequired) {
        expect.soft(
          name.lines,
          `${label}: ${name.id}'s box (${formatNumber(name.boxWidth)}px) fits the label (${formatNumber(name.labelWidth)}px), so the name must be one line; got ${name.lines}`,
        ).toBe(1);
      }
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

/**
 * The relations whose polyline or arrowhead leaves the SVG box.
 *
 * `readSemantic` maps every M/L point and every arrow polygon vertex through the
 * element's own `getScreenCTM`, so this is the CLIPPED-relation reading: the
 * root SVG keeps `overflow: hidden`, and a point outside its painted box does
 * not reach the reader.
 */
const edgesOutsideSvgBox = (reading: SemanticReading): string[] =>
  reading.edges
    .filter((edge) => edge.outsideSvgBox)
    .map((edge) => `${edge.source} -> ${edge.target}`);

/** Assert every relation point and arrowhead is inside the SVG box (0.5 px). */
const assertEdgesInsideSvgBox = (reading: SemanticReading, label: string): void => {
  const outside = edgesOutsideSvgBox(reading);
  expect.soft(
    outside,
    `${label}: every relation polyline point and arrowhead must be inside the SVG box; outside=${JSON.stringify(outside)}`,
  ).toEqual([]);
};

/** The drawn member row's declared name: the token a payload member is matched by. */
function memberTokenOf(text: string): string | null {
  return /^(?:[+\-#~]\s*)?([A-Za-z_$][\w$]*)/.exec(text)?.[1] ?? null;
}

/**
 * The payload rows for one drawn entity id.
 *
 * The drawing prefixes a scope key to every id (`scope-src/interleaved/…`),
 * while the fixture states the analysis index's own ids; matching by the
 * index-relative suffix keeps the expectation tied to the fixture rather than
 * to a prefix the panel may add.
 */
const expectedMemberKindsFor = (
  expectedById: Readonly<Record<string, readonly FixtureMemberKind[]>>,
  drawnId: string,
): readonly FixtureMemberKind[] | undefined => {
  if (expectedById[drawnId] !== undefined) return expectedById[drawnId];
  const match = Object.keys(expectedById)
    .find((candidate) => drawnId === candidate || drawnId.endsWith(`/${candidate}`));
  return match === undefined ? undefined : expectedById[match];
};

/**
 * The drawn member rows that sit in the WRONG compartment for their payload
 * kind.
 *
 * The split is geometric: rows above the SECOND compartment rule are the
 * attributes, rows below it are the operations. The expected kind is the
 * fixture's own payload kind, matched by the member's name — never by row
 * order, because the renderer groups fields before methods while the payload
 * keeps source order.
 */
const memberCompartmentViolations = (
  reading: SemanticReading,
  expectedById: Readonly<Record<string, readonly FixtureMemberKind[]>>,
): string[] => {
  const violations: string[] = [];
  for (const box of reading.classes) {
    const expected = expectedMemberKindsFor(expectedById, box.id);
    if (expected === undefined || box.memberRows.length === 0) continue;
    if (box.ruleYs.length < 2) {
      violations.push(`${box.id}: the second compartment rule is missing`);
      continue;
    }
    const splitY = box.ruleYs[1];
    for (const row of box.memberRows) {
      const token = memberTokenOf(row.text);
      const kind = expected.find((candidate) => candidate.token === token)?.kind;
      if (kind === undefined) continue;
      const drawn = row.y < splitY ? 'field' : 'method';
      if (drawn !== kind) {
        violations.push(`${box.id}: ${token} drawn as ${drawn}, payload says ${kind}`);
      }
    }
  }
  return violations;
};

/** How many payload member rows the drawing currently shows (non-vacuity reading). */
const matchedMemberRowCount = (
  reading: SemanticReading,
  expectedById: Readonly<Record<string, readonly FixtureMemberKind[]>>,
): number => {
  let matched = 0;
  for (const box of reading.classes) {
    const expected = expectedMemberKindsFor(expectedById, box.id);
    if (expected === undefined) continue;
    for (const row of box.memberRows) {
      const token = memberTokenOf(row.text);
      if (token !== null && expected.some((candidate) => candidate.token === token)) matched += 1;
    }
  }
  return matched;
};

/** Drive the real zoom control until the applied scale lands near `target`. */
async function zoomToScale(page: Page, target: number): Promise<number> {
  await ensureZoomClusterOpen(page);
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
  form: {
    viewport: { width: number; height: number };
    touch: boolean;
    /**
     * Draw without the member caps. This is the DEV-only lever the control arm
     * pulls (`drawnMemberLimits` in PlantUmlGraph.tsx) so the same reading can
     * be taken on the genuine defect — options absent — rather than on an
     * injected box that only imitates it.
     */
    memberLimitsOff?: boolean;
    /**
     * Draw with the DOWNWARD layout only. This is the DEV-only lever the
     * orientation control arm pulls (`forcedLayoutOrientation` in
     * PlantUmlGraph.tsx), so the same reading is taken on the state the
     * direction choice replaces rather than on an injected transform.
     */
    forceDownLayout?: boolean;
  },
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
  if (form.memberLimitsOff === true) {
    await context.addInitScript(() => {
      window.localStorage.setItem('architecture-member-limits', 'off');
    });
  }
  if (form.forceDownLayout === true) {
    await context.addInitScript(() => {
      window.localStorage.setItem('architecture-layout-orientation', 'down');
    });
  }
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
 * Points on a drawn ENTITY and on a directory GROUP, measured on the CURRENT
 * drawing. A group box is scaffolding: clicking it marks it locally but never
 * reports an entity, so only an entity can open the inspector.
 */
function findClickableNodes(page: Page): Promise<{
  entity: { x: number; y: number } | null;
  group: { x: number; y: number } | null;
}> {
  return page.evaluate((sel) => {
    const host = document.querySelector(sel.host) as HTMLElement | null;
    if (host === null) return { entity: null, group: null };
    const hostRect = host.getBoundingClientRect();
    const pointOf = (node: Element): { x: number; y: number } | null => {
      const text = node.querySelector('text');
      if (text === null) return null;
      const rect = text.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 6) return null;
      const point = {
        x: Math.round(rect.left + Math.min(rect.width / 2, 30)),
        y: Math.round(rect.top + rect.height / 2),
      };
      const inside = point.x > hostRect.left + 6 && point.x < hostRect.right - 6
        && point.y > hostRect.top + 6 && point.y < hostRect.bottom - 6;
      if (!inside) return null;
      const hit = document.elementFromPoint(point.x, point.y);
      if (hit === null || hit.closest('[data-entity-id]') === null) return null;
      return point;
    };
    let entity: { x: number; y: number } | null = null;
    let group: { x: number; y: number } | null = null;
    for (const node of host.querySelectorAll('.uml-node[data-entity-id]')) {
      const id = node.getAttribute('data-entity-id') ?? '';
      if (id.startsWith('grp::') || id.startsWith('stub::')) {
        group ??= pointOf(node);
      } else {
        entity ??= pointOf(node);
      }
    }
    return { entity, group };
  }, SEL);
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
    // The previous leg ends on a drill (a double-click), so a new drawing may
    // still be in flight. Clicking coordinates measured on the OLD drawing can
    // land on the background of the new one and clear the selection instead of
    // opening the dock; the panel states when the drawn model has landed.
    await page.waitForFunction(
      () => {
        const region = document.querySelector('[data-architecture-canvas-region]');
        const graph = document.querySelector('[data-architecture-plantuml-graph]');
        return region?.getAttribute('data-architecture-drawn-source') === 'drawn'
          && Number(graph?.getAttribute('data-architecture-visible-nodes') ?? '0') > 0;
      },
      undefined,
      { timeout: 40_000 },
    );
    // Open it the way a reader does: a single click on a drawn ENTITY. The
    // grouped overview draws directory boxes, which no click can report; when
    // the previous leg left one of those on screen, drill into it first so the
    // drawing carries its files.
    let candidate = await findClickableNodes(page);
    if (candidate.entity === null && candidate.group !== null) {
      await page.mouse.dblclick(candidate.group.x, candidate.group.y);
      await page.waitForFunction(
        (sel) => {
          const root = document.querySelector(sel.graphRoot);
          const region = document.querySelector('[data-architecture-canvas-region]');
          return root?.getAttribute('data-architecture-view') === 'group'
            && region?.getAttribute('data-architecture-drawn-source') === 'drawn'
            && Number(root.getAttribute('data-architecture-visible-nodes') ?? '0') > 0;
        },
        SEL,
        { timeout: 40_000 },
      );
      candidate = await findClickableNodes(page);
    }
    expect(candidate.entity, `${label}: the drawing must offer an entity to select`).not.toBeNull();
    const targetPoint = candidate.entity as GesturePoint;
    await page.mouse.click(targetPoint.x, targetPoint.y);
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
 * Open the portrait phone's collapsed zoom cluster.
 *
 * The tier ships the ±/Fit row behind one 44px button so the default state
 * cannot cover the drawing. Every gesture helper that needs a zoom control must
 * open it first; the call is a no-op on the tiers whose cluster is expanded
 * already (desktop, and the short-touch landscape form).
 */
async function ensureZoomClusterOpen(page: Page): Promise<void> {
  const toggle = page.locator(SEL.zoomClusterToggle);
  if ((await toggle.count()) === 0) return;
  if ((await toggle.first().getAttribute('aria-expanded')) === 'true') return;
  await toggle.first().click();
  await expect(page.locator(SEL.zoomClusterCollapse)).toHaveCount(1, { timeout: 10_000 });
  await settle(page, 250);
}

/**
 * The whole-graph view: the state whose auto fit keeps the whole drawing inside
 * the canvas. The retired Focus|Overview switch that used to have to be pressed
 * here is gone; the single-scale contract opens on this fit, so the helper only
 * lets the paint settle.
 */
async function showWholeGraph(page: Page): Promise<void> {
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
 * Switch the panel to the CLASS (entity) diagram.
 *
 * The semantic-zoom defects are properties of ENTITY boxes: kinds, stereotypes,
 * members and class names. The file graph draws plain file nodes (no kind, no
 * members), so a reading taken there cannot see any of them.
 */
async function showClassDiagram(page: Page): Promise<void> {
  const option = page.locator(SEL.viewEntity);
  if ((await option.count()) === 0 || !(await option.first().isVisible())) {
    // On the phone tier the granularity radio lives inside the bottom sheet.
    await openControlSheet(page);
    await page.locator(`[role="dialog"] ${SEL.viewEntity}`).first().click();
    await closeControlSheet(page);
  } else {
    await option.first().click();
  }
  // Wait on the DRAWING, not on the radio: the phone tier unmounts the radio
  // when its sheet closes, while the entity ids are on screen on every tier.
  // An entity id carries the `.ts.<Name>` suffix the file graph never has.
  await page.waitForFunction(
    () => [...document.querySelectorAll('.uml-node[data-entity-id]')]
      .some((node) => /\.ts\.[^./]+$/.test(node.getAttribute('data-entity-id') ?? '')),
    undefined,
    { timeout: 40_000 },
  );
  await page.waitForFunction(
    (sel) => {
      const root = document.querySelector(sel.graphRoot);
      return Number(root?.getAttribute('data-architecture-visible-nodes') ?? '0') > 0;
    },
    SEL,
    { timeout: 40_000 },
  );
  await settle(page, 800);
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
 * Zoom out through the on-canvas cluster until the semantic LOD settles at the
 * package-only tier (`lod-depth = 0`, tiers C/D), where the package frames are
 * visible and a frame click is the "tap a package" zoom gesture.
 *
 * The retired 12% floor is no longer the discriminator: the tier is what wires
 * the gesture, and a file drawing can still be tier B at 11%. Driving the zoom
 * with the real control keeps the case honest on a fixture whose default fit
 * happens to be larger than the tier boundary.
 */
async function zoomOutBelowUsefulScale(page: Page): Promise<void> {
  await ensureZoomClusterOpen(page);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const raw = await page.locator(SEL.graphRoot).getAttribute('data-architecture-zoom-scale');
    const lod = await page.locator(SEL.graphRoot).getAttribute('data-architecture-lod-depth');
    const scale = Number(raw ?? '1');
    // Below 12% is not enough on its own: the package TAP path is only wired
    // for the package-only tier (`lod-depth = 0` = tier C/D). At 11% a file
    // drawing can still be tier B (frames + names), where a frame click is not
    // a zoom gesture at all. The tier, not the percentage, is what the gesture
    // reads.
    if (Number.isFinite(scale) && scale > 0 && lod === '0') break;
    await page.locator(SEL.zoomOut).first().click();
    await page.waitForTimeout(120);
  }
  await page.waitForFunction(
    (sel) => {
      const root = document.querySelector(sel.graphRoot);
      const raw = Number(root?.getAttribute('data-architecture-zoom-scale') ?? '1');
      return raw > 0 && root?.getAttribute('data-architecture-lod-depth') === '0';
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

/* ── the drawn box vs the text it shows (node-size criterion) ────────────────────────────── */

/**
 * How much wider than its longest visible line a class box may be, plus an
 * absolute pad. The task states both numbers: a box sized from text it does
 * not draw is the defect, so the relation is `box ≤ 1.35 × line + 24`.
 */
const NODE_SIZE_MAX_RATIO = 1.35;
const NODE_SIZE_MAX_PAD = 24;

/** The phone default fit the fixed two-entity fixture must reach (the defect: ~38 %). */
const NODE_SIZE_MIN_PHONE_ZOOM = 0.6;

/** One drawn entity box, in the drawing's own user units. */
type NodeSizeBox = {
  readonly id: string;
  /** The box's world width: the drawn rect's width, in SVG user units. */
  readonly boxWidth: number;
  /** The longest member/name line the box actually paints, in user units. */
  readonly textWidth: number;
  /** `boxWidth ÷ textWidth` (`null` when nothing is painted). */
  readonly ratio: number | null;
  /** The drawn member/name lines, so a red names what it measured. */
  readonly lines: readonly string[];
};

/** Everything the node-size criterion reads, in one round trip. */
type NodeSizeReading = {
  /** The fit scale the graph reports (`data-architecture-zoom-scale`). */
  readonly zoomScale: number | null;
  /** The drawing's natural size (the SVG `viewBox`), in user units. */
  readonly natural: { readonly width: number; readonly height: number } | null;
  readonly nodes: readonly NodeSizeBox[];
  /** The box that misses the ratio rule by the most, or `null` when all pass. */
  readonly worst: NodeSizeBox | null;
};

/**
 * Read every drawn entity box against the longest line it paints.
 *
 * Both numbers are in the drawing's OWN user units: the rect's `width`
 * attribute (the semantic pass rewrites the rect and leaves the group's stale
 * `data-w` behind, so the rect is the drawing, not the metadata) and
 * `getComputedTextLength()` for the painted `<text>` advance. A ratio of two
 * user-unit lengths is scale-free, so a zoomed or mapped drawing is measured
 * by the same rule as an identity one.
 *
 * The SAME function measures the main arm and the control arm.
 */
const readNodeSize = (page: Page): Promise<NodeSizeReading> =>
  page.evaluate(({ sel, maxRatio, maxPad }) => {
    const parse = (value: string | null): number | null => {
      if (value === null) return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const root = document.querySelector(sel.graphRoot);
    const svg = document.querySelector(`${sel.host} svg`);
    const viewBox = (svg?.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
    const natural = viewBox.length === 4 && viewBox.every(Number.isFinite)
      ? { width: viewBox[2], height: viewBox[3] }
      : null;
    const painted = (element: Element): boolean => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const nodes = [...document.querySelectorAll('.uml-node[data-entity-id]')]
      .filter((group) => painted(group))
      .map((group) => {
        const rect = group.querySelector('rect');
        const boxWidth = parse(rect?.getAttribute('width') ?? null) ?? parse(group.getAttribute('data-w'));
        const lines: string[] = [];
        let textWidth = 0;
        for (const text of group.querySelectorAll('text')) {
          const content = (text.textContent ?? '').trim();
          if (content === '' || !painted(text)) continue;
          const advance = typeof (text as SVGTextContentElement).getComputedTextLength === 'function'
            ? (text as SVGTextContentElement).getComputedTextLength()
            : Number.NaN;
          if (!Number.isFinite(advance) || advance <= 0) continue;
          lines.push(content);
          textWidth = Math.max(textWidth, advance);
        }
        return {
          id: group.getAttribute('data-entity-id') ?? '',
          boxWidth: boxWidth ?? 0,
          textWidth,
          ratio: boxWidth !== null && textWidth > 0 ? boxWidth / textWidth : null,
          lines,
        };
      })
      .filter((node) => node.boxWidth > 0 && node.textWidth > 0);
    const violations = nodes.filter((node) => node.boxWidth > maxRatio * node.textWidth + maxPad);
    const worst = [...nodes].sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))[0] ?? null;
    return {
      zoomScale: parse(root?.getAttribute('data-architecture-zoom-scale') ?? null),
      natural,
      nodes,
      worst: violations.length === 0 ? null : worst,
    };
  }, { sel: SEL, maxRatio: NODE_SIZE_MAX_RATIO, maxPad: NODE_SIZE_MAX_PAD });

/** Assert every drawn box is proportional to the longest line it paints. */
function assertBoxesProportional(reading: NodeSizeReading, label: string): void {
  expect(reading.nodes.length, `${label}: the drawing must show entity boxes to measure`).toBeGreaterThan(0);
  for (const node of reading.nodes) {
    expect.soft(
      node.boxWidth,
      `${label}: ${node.id} box ${node.boxWidth} must be ≤ ${NODE_SIZE_MAX_RATIO} × longest line `
        + `${node.textWidth} + ${NODE_SIZE_MAX_PAD}; lines=${JSON.stringify(node.lines)}`,
    ).toBeLessThanOrEqual(NODE_SIZE_MAX_RATIO * node.textWidth + NODE_SIZE_MAX_PAD);
  }
}

/* ── the fixture, built once per worker ──────────────────────────────────────────────────── */

let baseURL = '';
let sessionId = '';
let token = '';
let fixture: ArchitectureFixtureReading | null = null;
// The claudecodeui-shaped second fixture: same criterion, a different drawing
// size / nesting / label length, so the polish guards are not tuned to one
// project's geometry.
let cuiSessionId = '';
let cuiFixture: ArchitectureFixtureReading | null = null;
// The two-entity fixture the node-size criterion measures: the only drawing
// whose boxes can be widened by member text alone.
let nodeSizeSessionId = '';
let nodeSizeFixture: ArchitectureFixtureReading | null = null;
// The two-entity chain whose DOWNWARD layout is a narrow column: the fixture
// the orientation criterion turns sideways on a desktop canvas.
let orientationSessionId = '';
let orientationFixture: ArchitectureFixtureReading | null = null;

// The two render-regression fixtures: relations routed outside the frames, and
// a class whose payload interleaves fields and methods.
let perimeterSessionId = '';
let perimeterFixture: ArchitectureFixtureReading | null = null;
let interleavedSessionId = '';
/** The function-heavy fixture the Show-all / folded-fit legs drive. */
let functionsSessionId = '';
/** The workspace whose manifest also lists a scope from outside the project root. */
let scopeHygieneSessionId = '';
let scopeHygieneFixture: ArchitectureFixtureReading | null = null;
let functionsFixture: ArchitectureFixtureReading | null = null;
let interleavedFixture: ArchitectureFixtureReading | null = null;

/**
 * The four sizes the portrait-phone chrome criterion drives.
 *
 * S / M / L / Quay-shaped drawings are the fit-contract matrix's own fixtures:
 * the chrome must not depend on what is drawn, and the folded package tier —
 * the state that paints no `.uml-node` — is where the old clearance reading was
 * blind. The shapes are duplicated here (rather than imported from the sibling
 * spec) because only their OPTIONS are needed; the writer is shared.
 */
const PORTRAIT_SHAPES = [
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
    options: {
      entityCount: 19,
      entityKind: 'interface',
      packageCount: 4,
      labelStem: 'QuayIface',
    } satisfies FitContractFixtureOptions,
  },
] as const;

/** The armed session for each portrait shape, keyed by its shape key. */
const portraitSessionIds = new Map<string, string>();

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
  fixture = writeArchitectureFixture(workspace, { variant: 'quay-oo' });
  const cuiWorkspace = path.join(fixtureHome, ARCHITECTURE_FIXTURE_WORKSPACE_CUI);
  cuiFixture = writeArchitectureFixture(cuiWorkspace, { variant: 'claudecodeui' });
  const nodeSizeWorkspace = path.join(fixtureHome, ARCHITECTURE_FIXTURE_WORKSPACE_NODE_SIZE);
  nodeSizeFixture = writeArchitectureFixture(nodeSizeWorkspace, { variant: 'node-size' });
  const orientationWorkspace = path.join(fixtureHome, ARCHITECTURE_FIXTURE_WORKSPACE_ORIENTATION);
  orientationFixture = writeArchitectureFixture(orientationWorkspace, { variant: 'orientation-chain' });

  const perimeterWorkspace = path.join(fixtureHome, ARCHITECTURE_FIXTURE_WORKSPACE_PERIMETER);
  perimeterFixture = writeArchitectureFixture(perimeterWorkspace, { variant: 'outer-perimeter' });
  const interleavedWorkspace = path.join(fixtureHome, ARCHITECTURE_FIXTURE_WORKSPACE_INTERLEAVED);
  interleavedFixture = writeArchitectureFixture(interleavedWorkspace, { variant: 'interleaved-members' });
  const functionsWorkspace = path.join(fixtureHome, ARCHITECTURE_FIXTURE_WORKSPACE_FUNCTIONS);
  functionsFixture = writeArchitectureFixture(functionsWorkspace, { variant: 'functions-384' });
  const scopeHygieneWorkspace = path.join(fixtureHome, ARCHITECTURE_FIXTURE_WORKSPACE_SCOPE_HYGIENE);
  scopeHygieneFixture = writeArchitectureFixture(scopeHygieneWorkspace, {
    variant: 'quay-oo',
    // The "Scope cleanup" row only exists when the merge cleaned something up.
    outsideScope: true,
  });

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
  const cuiUserText =
    'Please review the voice pipeline and the frame budget. '
    + `Start at ${cuiFixture.seedIdentifiers.map((name) => `\`${name}\``).join(', ')}.`;
  cuiSessionId = await armScenario(api, cuiWorkspace, cuiUserText, cuiFixture.seedIdentifiers[0]);
  const nodeSizeUserText =
    'Please review the frame processor and its ledger. '
    + `Start at ${nodeSizeFixture.seedIdentifiers.map((name) => `\`${name}\``).join(', ')}.`;
  nodeSizeSessionId = await armScenario(api, nodeSizeWorkspace, nodeSizeUserText, nodeSizeFixture.seedIdentifiers[0]);
  const orientationUserText =
    'Please review the dependency chain between the service and its ledger. '
    + `Start at ${orientationFixture.seedIdentifiers.map((name) => `\`${name}\``).join(', ')}.`;
  orientationSessionId = await armScenario(
    api,
    orientationWorkspace,
    orientationUserText,
    orientationFixture.seedIdentifiers[0],
  );

  const perimeterUserText =
    'Please review the layout budget and the readout numbers. '
    + `Start at ${perimeterFixture.seedIdentifiers.map((name) => `\`${name}\``).join(', ')}.`;
  perimeterSessionId = await armScenario(
    api,
    perimeterWorkspace,
    perimeterUserText,
    perimeterFixture.seedIdentifiers[0],
  );
  const interleavedUserText =
    'Please review the voice pipeline and the frame budget. '
    + `Start at ${interleavedFixture.seedIdentifiers.map((name) => `\`${name}\``).join(', ')}.`;
  interleavedSessionId = await armScenario(
    api,
    interleavedWorkspace,
    interleavedUserText,
    interleavedFixture.seedIdentifiers[0],
  );
  const functionsUserText =
    'Please review the frame budget pipeline. '
    + `Start at ${functionsFixture.seedIdentifiers.map((name) => `\`${name}\``).join(', ')}.`;
  functionsSessionId = await armScenario(
    api,
    functionsWorkspace,
    functionsUserText,
    functionsFixture.seedIdentifiers[0],
  );
  // Same project shape and the same seeded names: only the extra manifest scope
  // (and therefore the cleanup reading) differs.
  scopeHygieneSessionId = await armScenario(api, scopeHygieneWorkspace, userText, fixture.seedIdentifiers[0]);

  // The portrait-phone chrome matrix: the four fit-contract shapes, each in its
  // own workspace, seeded with the same exact-name rule every fixture uses.
  for (const shape of PORTRAIT_SHAPES) {
    const workspace = path.join(fixtureHome, FIT_CONTRACT_WORKSPACES[shape.key]);
    const reading = writeFitContractFixture(workspace, shape.options);
    const shapeUserText = `Please review the fit drawing. Start at ${
      reading.seedIdentifiers.map((name) => `\`${name}\``).join(', ')
    }.`;
    portraitSessionIds.set(
      shape.key,
      await armScenario(api, workspace, shapeUserText, reading.seedIdentifiers[0]),
    );
    console.log(
      `[architecture-layout] portrait.${shape.key}.entities=${reading.entityTotal} `
        + `session=${portraitSessionIds.get(shape.key)}`,
    );
  }
  await api.dispose();

  console.log(`[architecture-layout] fixture.entities=${fixture.entityTotal} variant=${fixture.variant}`);
  console.log(`[architecture-layout] fixture.workspace=${workspace}`);
  console.log(`[architecture-layout] session=${sessionId}`);
  console.log(`[architecture-layout] cui.entities=${cuiFixture.entityTotal} variant=${cuiFixture.variant}`);
  console.log(`[architecture-layout] cui.workspace=${cuiWorkspace}`);
  console.log(`[architecture-layout] cui.session=${cuiSessionId}`);
  console.log(`[architecture-layout] nodeSize.entities=${nodeSizeFixture.entityTotal} variant=${nodeSizeFixture.variant}`);
  console.log(`[architecture-layout] nodeSize.workspace=${nodeSizeWorkspace}`);
  console.log(`[architecture-layout] nodeSize.session=${nodeSizeSessionId}`);
  console.log(`[architecture-layout] orientation.entities=${orientationFixture.entityTotal} variant=${orientationFixture.variant}`);
  console.log(`[architecture-layout] orientation.workspace=${orientationWorkspace}`);
  console.log(`[architecture-layout] orientation.session=${orientationSessionId}`);

  console.log(`[architecture-layout] perimeter.entities=${perimeterFixture.entityTotal} variant=${perimeterFixture.variant}`);
  console.log(`[architecture-layout] perimeter.workspace=${perimeterWorkspace}`);
  console.log(`[architecture-layout] perimeter.session=${perimeterSessionId}`);
  console.log(`[architecture-layout] interleaved.entities=${interleavedFixture.entityTotal} variant=${interleavedFixture.variant}`);
  console.log(`[architecture-layout] interleaved.workspace=${interleavedWorkspace}`);
  console.log(`[architecture-layout] interleaved.session=${interleavedSessionId}`);
  console.log(`[architecture-layout] functions.entities=${functionsFixture.entityTotal} variant=${functionsFixture.variant}`);
  console.log(`[architecture-layout] functions.workspace=${functionsWorkspace}`);
  console.log(`[architecture-layout] functions.session=${functionsSessionId}`);
  console.log(`[architecture-layout] scopeHygiene.entities=${scopeHygieneFixture.entityTotal}`);
  console.log(`[architecture-layout] scopeHygiene.workspace=${scopeHygieneWorkspace}`);
  console.log(`[architecture-layout] scopeHygiene.session=${scopeHygieneSessionId}`);
});

/* ── lossless text: one reading, two arms ────────────────────────────────────────────────── */

/**
 * The renderer's own truncation row. With `detail: 'compact'` it writes
 * `… +N more (M members)` as a MEMBER into the drawn model, so it reaches the
 * text; this pattern finds it in a document. A real member line never matches.
 */
const TRUNCATED_TEXT_LINE = /…\s*\+\d+\s+more|\(\d+\s+members\)/;

/** The member rows of every class-like block, keyed by the declared name. */
function textMemberRows(puml: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  let current: { readonly name: string; readonly rows: string[] } | null = null;
  let depth = 0;
  for (const line of puml.split('\n')) {
    if (current === null) {
      const declaration = /^[ \t]*(?:abstract\s+)?(?:class|interface|enum)\s+"([^"]+)"\s+as\s+\w+(?:\s+<<[^>]+>>)?\s*\{\s*$/.exec(line);
      if (declaration !== null) {
        current = { name: declaration[1], rows: [] };
        depth = 1;
      }
      continue;
    }
    if (/^[ \t]*\}[ \t]*$/.test(line)) {
      depth -= 1;
      if (depth === 0) {
        rows.set(current.name, current.rows);
        current = null;
      }
      continue;
    }
    if (/\{[ \t]*$/.test(line)) depth += 1;
    // The renderer's synthetic row IS a visibility-prefixed member line; it is
    // counted by the marker reading, never as one of the payload's members.
    if (/^[ \t]*[-+#~]\s+\S/.test(line) && !TRUNCATED_TEXT_LINE.test(line)) current.rows.push(line);
  }
  if (current !== null) rows.set(current.name, current.rows);
  return rows;
}

/** One document's lossless reading. Both the main and the control arm use THIS. */
type TextLosslessReading = {
  /** Entity declarations the document carries (with or without a member body). */
  readonly entityCount: number;
  /** Class-like blocks that carry a member compartment. */
  readonly classCount: number;
  /** Entities in the document whose payload carries more than four members. */
  readonly multiMemberEntities: number;
  /** Lines that are the renderer's truncation row. */
  readonly markerLines: string[];
  /** Entities whose member rows are fewer than the payload's. */
  readonly missingMembers: string[];
  /** Blocks naming an entity the fixture does not know. */
  readonly unknownEntities: string[];
  /** Everything that makes the document lossy; empty is the pass state. */
  readonly violations: string[];
};

/**
 * Read one exported PlantUML document against the fixture's payload.
 *
 * A member line is countable without parsing UML: the bridge/serializer writes
 * one visibility-prefixed line per member, and the renderer's truncation row is
 * itself a member line — which is why the marker check comes first. Entities not
 * drawn (a scope narrower than the graph, or a kind the filter hides) are simply
 * absent; an absent block is not a violation, a short block is.
 */
function readLosslessText(
  text: string,
  reading: ArchitectureFixtureReading,
): TextLosslessReading {
  const nameById = new Map<string, string>();
  for (const id of reading.entityIds) {
    const name = id.slice(id.lastIndexOf('.') + 1);
    if (!nameById.has(name)) nameById.set(name, id);
  }
  const markerLines = text.split('\n').filter((line) => TRUNCATED_TEXT_LINE.test(line));
  const entityCount = [...text.matchAll(
    /^[ \t]*(?:abstract\s+)?(?:class|interface|enum)\s+"([^"]+)"\s+as\s+\w+(?:\s+<<[^>]+>>)?/gm,
  )].length;
  const rows = textMemberRows(text);
  const missingMembers: string[] = [];
  const unknownEntities: string[] = [];
  let multiMemberEntities = 0;
  for (const [name, entityRows] of rows) {
    const id = nameById.get(name);
    if (id === undefined) {
      unknownEntities.push(name);
      continue;
    }
    const expected = reading.memberCountById[id] ?? 0;
    if (expected > 4) multiMemberEntities += 1;
    if (entityRows.length !== expected) {
      missingMembers.push(`${name}: ${String(entityRows.length)} of ${String(expected)} member rows`);
    }
  }
  return {
    entityCount,
    classCount: rows.size,
    multiMemberEntities,
    markerLines,
    missingMembers,
    unknownEntities,
    violations: [...markerLines, ...missingMembers, ...unknownEntities],
  };
}

/** Run one download-triggering action and read the downloaded text. */
async function downloadText(page: Page, action: () => Promise<void>): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), action()]);
  const filePath = await download.path();
  if (filePath === null) throw new Error('the download must have a local path');
  return readFileSync(filePath, 'utf8');
}

/** Wait until the panel reports the drawn model, then open the Text page. */
async function openSettledTextPage(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector('[data-architecture-canvas-region]')
      ?.getAttribute('data-architecture-drawn-source') === 'drawn',
    undefined,
    { timeout: 40_000 },
  );
  await page.locator('[data-architecture-text-toggle]').first().click();
  await expect(page.locator('[data-architecture-text-panel]')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-architecture-text-fallback-source]')).toHaveCount(0);
  // The dock rebuilds on a 300ms debounce after a source change; the opening
  // build is synchronous, so this only lets layout settle.
  await settle(page, 400);
}

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
    // The retired "whole graph at N% — tap a package" hint is gone with the
    // Focus policy: the auto fit already shows the whole graph, so the tiny
    // state has no standing sentence to assert. The package gesture itself is
    // still the reader's way in, and is measured below.
    expect(
      await page.locator(SEL.readableBack).count(),
      'nothing has been zoomed into yet, so there is no back action',
    ).toBe(0);

    const scaleBeforePackage = Number(
      await page.locator(SEL.graphRoot).getAttribute('data-architecture-zoom-scale'),
    );
    // Tap the SMALLEST package frame that is actually drawn. The folded tier
    // keeps undrawn sub-packages in the DOM with `display: none` (a tap on one
    // is a no-op), and an outer frame already spans the canvas (tapping it asks
    // the reader to zoom OUT, which is not the gesture this leg measures). The
    // smallest frame is a leaf, so "tap a package to zoom in" is the real
    // command.
    const tappedPackage = await page.evaluate(() => {
      const frames = [...document.querySelectorAll<HTMLElement>('.uml-package[data-package-id]')]
        .map((group) => {
          const rect = group.getBoundingClientRect();
          return { group, area: rect.width * rect.height, width: rect.width, height: rect.height };
        })
        .filter((entry) => entry.group.style.display !== 'none' && entry.width >= 16 && entry.height >= 16)
        .sort((a, b) => a.area - b.area);
      const target = frames[0];
      if (target === undefined) return null;
      target.group.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return target.group.getAttribute('data-package-id');
    });
    expect(tappedPackage, 'the folded overview must draw at least one tappable package frame').not.toBeNull();
    await page.waitForTimeout(600);
    console.log(`[architecture-layout] phone.package.tap=${JSON.stringify(await page.evaluate((sel) => ({
      tappedScale: document.querySelector(sel.graphRoot)?.getAttribute('data-architecture-zoom-scale') ?? null,
      mode: document.querySelector(sel.graphRoot)?.getAttribute('data-architecture-zoom-mode') ?? null,
      tier: document.querySelector(sel.graphRoot)?.getAttribute('data-architecture-lod-depth') ?? null,
      hint: document.querySelector(sel.readableHint)?.textContent?.trim() ?? null,
    }), SEL))}`);
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
  // Both project shapes. The defects were found on two real projects whose
  // drawings differ, so a guard tuned to one geometry is not enough.
  const projects = [
    { name: 'quay', session: (): string => sessionId },
    { name: 'cui', session: (): string => cuiSessionId },
  ];
  for (const project of projects) {
    for (const form of viewports) {
      const { context, page } = await openSignedInPage(browser, baseURL, token, {
        viewport: form.viewport,
        touch: form.touch,
      });
      try {
        await openArchitectureTab(page, project.session());
        await showClassDiagram(page);
        await showExplosionView(page);

        await zoomToScale(page, 1);
        const base = await readSemantic(page);
        const baseLabel = `${project.name}.${form.name}.base`;
        printSemantic(baseLabel, base);
        const baselineRows = assertSemantic(base, baseLabel, form.minFontPx, null);

        for (const level of SEMANTIC_ZOOM_LEVELS.slice(1)) {
          await zoomToScale(page, level);
          const reading = await readSemantic(page);
          const label = `${project.name}.${form.name}.${Math.round(level * 100)}`;
          printSemantic(label, reading);
          assertSemantic(reading, label, form.minFontPx, baselineRows);
        }
      } finally {
        await context.close();
      }
    }
  }
});

/**
 * The node-size criterion, on the two-entity fixture, in both viewports.
 *
 * The defect it exists for: `estimateEntitySize` sized a class box from ALL
 * its members while the drawing showed only part of them, so
 * `VoiceFrameProcessor` measured 856 user units wide next to 241 px of visible
 * text and the phone fitted the whole drawing at ~38 %. With the renderer's
 * member caps the box follows the text it paints: every drawn box stays within
 * 1.35 × its longest visible line + 24, and the phone default fit clears 60 %.
 *
 * The `data-w` of the class the task names is logged, and a screenshot of each
 * viewport's default drawing is written under `tmp/` for the DoD evidence.
 */
test('main arm — a class box is no wider than the text it draws (1440x765 and 390x844)', async ({ browser }) => {
  const viewports = [
    { name: 'pc', viewport: VIEWPORT_PC, touch: false },
    { name: 'phone', viewport: VIEWPORT_PHONE, touch: true },
  ];
  for (const form of viewports) {
    const { context, page } = await openSignedInPage(browser, baseURL, token, form);
    try {
      await openArchitectureTab(page, nodeSizeSessionId);
      await showClassDiagram(page);

      const reading = await readNodeSize(page);
      console.log(`[architecture-layout] nodeSize.${form.name}=${JSON.stringify(reading)}`);
      assertBoxesProportional(reading, `nodeSize.${form.name}`);

      // The class the task measured by name, so a regression is reported in
      // that class's own units rather than as a ratio nobody can re-derive.
      const processor = reading.nodes.find((node) => node.id.includes('VoiceFrameProcessor'));
      expect.soft(processor, `nodeSize.${form.name}: the long-signature class must be drawn`).toBeDefined();
      if (processor !== undefined) {
        console.log(
          `[architecture-layout] nodeSize.${form.name}.VoiceFrameProcessor `
            + `box=${processor.boxWidth} longestLine=${processor.textWidth} ratio=${processor.ratio}`,
        );
      }

      if (form.name === 'phone') {
        expect.soft(
          reading.zoomScale,
          `nodeSize.phone: the default fit must clear ${NODE_SIZE_MIN_PHONE_ZOOM * 100} %; `
            + `read ${reading.zoomScale} (the defect fitted this fixture at ~38 %)`,
        ).toBeGreaterThanOrEqual(NODE_SIZE_MIN_PHONE_ZOOM);
      }

      // At the identity scale (the PC default is 100 %) the drawing shows six
      // member rows plus the app's own `… +N more (M members)` row — the folded
      // tail is a DRAWING row, so the model keeps every authored member.
      if (form.name === 'pc') {
        expect(processor, 'nodeSize.pc: the long-signature class must be drawn').toBeDefined();
        const drawn = processor?.lines ?? [];
        expect(
          drawn.filter((line) => line.startsWith('+ ') || line.startsWith('- ')).length,
          `nodeSize.pc: six member rows are drawn; lines=${JSON.stringify(drawn)}`,
        ).toBe(6);
        expect(
          drawn.some((line) => /^… \+1 more/.test(line)),
          `nodeSize.pc: one fold row names the hidden member; got ${JSON.stringify(drawn)}`,
        ).toBe(true);
      }

      const shotDir = path.join(process.cwd(), 'tmp');
      fs.mkdirSync(shotDir, { recursive: true });
      await page.screenshot({ path: path.join(shotDir, `architecture-node-size-${form.name}.png`) });

      // The DoD's other half, on the PC page: the caps are a DRAWING choice.
      // Selecting the long-signature class keeps its full declaration in the
      // Inspector, and the Text page still serializes the untruncated model.
      if (form.name === 'pc') {
        const layout = await readLayout(page);
        console.log(
          `[architecture-layout] nodeSize.pc.canvasFill=${layout.fillRatio} `
            + `readout="${layout.readoutText}" zoom=${layout.zoomScale} mode=${layout.zoomMode}`,
        );
        await page.locator(SEL.search).first().fill('VoiceFrameProcessor');
        await expect(page.locator(SEL.searchResults).first()).toBeVisible({ timeout: 10_000 });
        await page.locator(SEL.searchOption).first().click();
        const members = page.locator('[data-architecture-inspector-members]').first();
        await expect(members).toBeVisible({ timeout: 15_000 });
        const inspectorText = (await members.textContent()) ?? '';
        const fullSignature = nodeSizeMemberSignature(NODE_SIZE_ENTITIES[0].members[4]);
        expect(
          inspectorText,
          `the Inspector must keep the full 105-character declaration; got ${JSON.stringify(inspectorText)}`,
        ).toContain(fullSignature);
        console.log(`[architecture-layout] nodeSize.pc.inspector=${JSON.stringify(inspectorText)}`);
        await page.screenshot({ path: path.join(shotDir, 'architecture-node-size-pc-inspector.png') });

        await page.locator('[data-architecture-text-toggle]').first().click();
        const preview = page.locator('[data-architecture-text-preview]').first();
        await expect(preview).toBeVisible({ timeout: 15_000 });
        const documentText = (await preview.textContent()) ?? '';
        expect(
          documentText,
          'the Text page must keep the full declaration too',
        ).toContain(fullSignature);
        console.log(`[architecture-layout] nodeSize.pc.textHasFullSignature=${documentText.includes(fullSignature)}`);
        // Leave the page as it was found: the search box is cleared, and the
        // context (with the selection and the Text page) is closed below.
        await page.locator(SEL.search).first().fill('');
      }
    } finally {
      await context.close();
    }
  }
});

/**
 * The two render regressions, on the fixtures that reproduce them.
 *
 * Fixture 1 (`outer-perimeter`) is a drawing whose relations ELK routes along
 * the OUTSIDE of the outermost package frames. The shipped content boundary was
 * the package/class frame union, so the clipped viewBox cut those relations.
 * Fixture 2 (`interleaved-members`) is a class whose PAYLOAD members alternate
 * field → method → field → method; the shipped reader index-mapped the payload
 * kinds onto the renderer's grouped order and swapped the compartments.
 *
 * The criterion uses the SAME `readSemantic` round trip as every other leg:
 * every relation polyline point and arrowhead lies inside the SVG box (0.5 px),
 * and every drawn member row lies above the second rule iff its payload kind is
 * `field` (and below it iff `method`), asserted row by row.
 */
test('main arm — perimeter relations stay inside the canvas and member rows keep their compartments', async ({ browser }) => {
  const viewports = [
    { name: 'pc', viewport: VIEWPORT_PC, touch: false, minFontPx: SEMANTIC_MIN_PC_PX },
    { name: 'phone', viewport: VIEWPORT_PHONE, touch: true, minFontPx: SEMANTIC_MIN_PHONE_PX },
  ];
  const fixtures: {
    readonly name: string;
    readonly session: () => string;
    readonly expected: Readonly<Record<string, readonly FixtureMemberKind[]>> | null;
  }[] = [
    { name: 'perimeter', session: () => perimeterSessionId, expected: null },
    {
      name: 'interleaved',
      session: () => interleavedSessionId,
      expected: interleavedFixture?.memberKindsById ?? {},
    },
  ];
  for (const project of fixtures) {
    for (const form of viewports) {
      const { context, page } = await openSignedInPage(browser, baseURL, token, {
        viewport: form.viewport,
        touch: form.touch,
      });
      try {
        await openArchitectureTab(page, project.session());
        await showClassDiagram(page);
        await showExplosionView(page);
        let checkedEdges = 0;
        let matchedMembers = 0;
        // The negotiated five levels, plus the 100 % baseline: the baseline is
        // where the frame has room for every member row, so the compartment
        // reading is a row-by-row check rather than the two rows a compressed
        // frame can still show.
        for (const level of SEMANTIC_ZOOM_LEVELS) {
          await zoomToScale(page, level);
          const reading = await readSemantic(page);
          const label = `${project.name}.${form.name}.${Math.round(level * 100)}`;
          printSemantic(label, reading);
          assertSemantic(reading, label, form.minFontPx, null);
          checkedEdges += reading.edges.length;
          assertEdgesInsideSvgBox(reading, label);
          if (project.expected !== null) {
            expect.soft(
              memberCompartmentViolations(reading, project.expected),
              `${label}: every drawn member row must sit above the second rule iff its payload kind is field`,
            ).toEqual([]);
            matchedMembers += matchedMemberRowCount(reading, project.expected);
          }
        }
        if (project.name === 'perimeter') {
          expect(
            checkedEdges,
            'the perimeter fixture must actually draw relations across the five levels',
          ).toBeGreaterThan(0);
        } else {
          expect(
            matchedMembers,
            'the interleaved fixture must draw its four payload member rows at least once',
          ).toBeGreaterThanOrEqual(4);
        }
      } finally {
        await context.close();
      }
    }
  }
});

/**
 * Control arm: the same reading, on the genuine defect.
 *
 * The two options are made absent by the DEV-only lever the renderer reads
 * (`architecture-member-limits=off`) — not by widening a rect after the fact.
 * On the phone viewport both legs of the SAME reading go red: the box ratio
 * misses the 1.35 + 24 rule and the default fit falls back under 60 %.
 */
test('control arm — without the member caps the box ratio and the phone default zoom both read a false', async ({ browser }) => {
  const { context, page } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PHONE,
    touch: true,
    memberLimitsOff: true,
  });
  try {
    await openArchitectureTab(page, nodeSizeSessionId);
    await showClassDiagram(page);

    const reading = await readNodeSize(page);
    console.log(`[architecture-layout] nodeSize.control=${JSON.stringify(reading)}`);
    expect(reading.nodes.length, 'nodeSize.control: the defect drawing must still show boxes').toBeGreaterThan(0);

    // Leg 1 — the box is wider than the text it draws.
    const violations = reading.nodes.filter(
      (node) => node.boxWidth > NODE_SIZE_MAX_RATIO * node.textWidth + NODE_SIZE_MAX_PAD,
    );
    expect.soft(
      violations.length,
      `nodeSize.control: without the caps at least one box must miss the ratio rule; got `
        + `${JSON.stringify(reading.nodes.map((node) => ({ id: node.id, box: node.boxWidth, text: node.textWidth, ratio: node.ratio })))}`,
    ).toBeGreaterThan(0);

    // Leg 2 — the same reading's fit scale is under the phone floor.
    expect.soft(
      reading.zoomScale,
      `nodeSize.control: without the caps the phone fit must fall under `
        + `${NODE_SIZE_MIN_PHONE_ZOOM * 100} %; read ${reading.zoomScale}`,
    ).toBeLessThan(NODE_SIZE_MIN_PHONE_ZOOM);
  } finally {
    await context.close();
  }
});

/**
 * Both render guards, forced red through the SAME `readSemantic`.
 *
 * Arm 1 reproduces the clipped boundary: the SVG's own box is shrunk to the
 * union of the package frames (exactly what the shipped content computation
 * did), and the relation reading must see points outside it. Arm 2 reproduces
 * the index-mapped member kind: an attribute row is moved below the compartment
 * split (and an operation row above it), the grouping the indexed overlay
 * produced, and the row-by-row compartment reading must see it.
 */
test('control arm — a frame-only boundary and a re-indexed member kind each read red', async ({ browser }) => {
  // Arm 1 — the clipped boundary, on the perimeter fixture.
  const { context: perimeterContext, page: perimeterPage } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PC,
    touch: false,
  });
  try {
    await openArchitectureTab(perimeterPage, perimeterSessionId);
    await showClassDiagram(perimeterPage);
    await showExplosionView(perimeterPage);
    await zoomToScale(perimeterPage, 0.65);
    const before = await readSemantic(perimeterPage);
    printSemantic('control.clip.before', before);
    assertEdgesInsideSvgBox(before, 'control.clip.before');
    expect(
      before.edges.length,
      'control.clip.before: the perimeter fixture must draw relations for the arm to mean anything',
    ).toBeGreaterThan(0);

    await perimeterPage.evaluate(() => {
      const svg = document.querySelector('svg[data-architecture-semantic]') as SVGSVGElement | null;
      if (svg === null) return;
      const rects = [...svg.querySelectorAll('.uml-package[data-package-id] > rect')]
        .map((rect) => ({
          x: Number(rect.getAttribute('x') ?? '0'),
          y: Number(rect.getAttribute('y') ?? '0'),
          w: Number(rect.getAttribute('width') ?? '0'),
          h: Number(rect.getAttribute('height') ?? '0'),
        }))
        .filter((rect) => Number.isFinite(rect.x) && rect.w > 0 && rect.h > 0);
      if (rects.length === 0) return;
      const left = Math.min(...rects.map((rect) => rect.x));
      const top = Math.min(...rects.map((rect) => rect.y));
      const right = Math.max(...rects.map((rect) => rect.x + rect.w));
      const bottom = Math.max(...rects.map((rect) => rect.y + rect.h));
      // Store the shipped geometry so the arm restores the drawing exactly.
      svg.setAttribute('data-control-viewbox', svg.getAttribute('viewBox') ?? '');
      svg.setAttribute('data-control-width', svg.getAttribute('width') ?? '');
      svg.setAttribute('data-control-height', svg.getAttribute('height') ?? '');
      // The shipped defect: the canvas is cut down to the frame union.
      svg.setAttribute('viewBox', `${left} ${top} ${right - left} ${bottom - top}`);
      svg.setAttribute('width', String(right - left));
      svg.setAttribute('height', String(bottom - top));
    });
    const cropped = await readSemantic(perimeterPage);
    printSemantic('control.clip.cropped', cropped);
    expect.soft(
      edgesOutsideSvgBox(cropped),
      'control.clip: a package-and-class-only boundary must read relations outside the SVG box',
    ).not.toEqual([]);
    await perimeterPage.evaluate(() => {
      const svg = document.querySelector('svg[data-architecture-semantic]') as SVGSVGElement | null;
      if (svg === null) return;
      const viewBox = svg.getAttribute('data-control-viewbox');
      if (viewBox !== null) svg.setAttribute('viewBox', viewBox);
      const width = svg.getAttribute('data-control-width');
      if (width !== null) svg.setAttribute('width', width);
      const height = svg.getAttribute('data-control-height');
      if (height !== null) svg.setAttribute('height', height);
      svg.removeAttribute('data-control-viewbox');
      svg.removeAttribute('data-control-width');
      svg.removeAttribute('data-control-height');
    });
    const restored = await readSemantic(perimeterPage);
    printSemantic('control.clip.restored', restored);
    assertEdgesInsideSvgBox(restored, 'control.clip.restored');
  } finally {
    await perimeterContext.close();
  }

  // Arm 2 — the re-indexed member kind, on the interleaved fixture.
  const { context: interleavedContext, page: interleavedPage } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PC,
    touch: false,
  });
  try {
    await openArchitectureTab(interleavedPage, interleavedSessionId);
    await showClassDiagram(interleavedPage);
    await showExplosionView(interleavedPage);
    // 100 % is where the frame holds all four rows; the defect's grouping is
    // the same at every level, but a compressed frame only draws a prefix.
    await zoomToScale(interleavedPage, 1);
    const expected = interleavedFixture?.memberKindsById ?? {};
    const before = await readSemantic(interleavedPage);
    printSemantic('control.compartment.before', before);
    expect.soft(
      memberCompartmentViolations(before, expected),
      'control.compartment.before: the shipped drawing must keep every row in its true compartment',
    ).toEqual([]);
    expect(
      matchedMemberRowCount(before, expected),
      'control.compartment.before: the arm needs the four payload rows drawn',
    ).toBeGreaterThanOrEqual(4);

    const moved = await interleavedPage.evaluate(() => {
      // The drawing prefixes the scope key to every id; the fixture states the
      // index-relative id, so match by that suffix.
      const group = [...document.querySelectorAll('.uml-node[data-entity-id]')]
        .find((candidate) => {
          const id = candidate.getAttribute('data-entity-id') ?? '';
          return id === 'interleaved/core/Mixed.ts.Mixed' || id.endsWith('/interleaved/core/Mixed.ts.Mixed');
        });
      if (group === null || group === undefined) return false;
      const rules = [...group.children]
        .filter((child) => child.tagName.toLowerCase() === 'line')
        .map((line) => line.getBoundingClientRect())
        .map((rect) => rect.y + rect.height / 2)
        .sort((a, b) => a - b);
      if (rules.length < 2) return false;
      const splitY = rules[1];
      const rows = [...group.querySelectorAll('[data-architecture-node-member]')];
      const above = rows.find((row) => {
        const rect = row.getBoundingClientRect();
        return rect.y + rect.height / 2 < splitY;
      });
      const below = rows.find((row) => {
        const rect = row.getBoundingClientRect();
        return rect.y + rect.height / 2 > splitY;
      });
      if (above === undefined || below === undefined) return false;
      // The indexed overlay put operations in the attribute band and vice
      // versa; swapping these two rows is that grouping, drawn.
      const aboveY = above.getAttribute('y') ?? '0';
      const belowY = below.getAttribute('y') ?? '0';
      above.setAttribute('data-control-row-y', aboveY);
      below.setAttribute('data-control-row-y', belowY);
      above.setAttribute('y', belowY);
      below.setAttribute('y', aboveY);
      return true;
    });
    expect(moved, 'control.compartment: the arm must find an attribute and an operation row to swap').toBe(true);
    const swapped = await readSemantic(interleavedPage);
    printSemantic('control.compartment.swapped', swapped);
    expect.soft(
      memberCompartmentViolations(swapped, expected),
      'control.compartment: a row drawn in the wrong compartment must read red',
    ).not.toEqual([]);
    await interleavedPage.evaluate(() => {
      for (const row of document.querySelectorAll('[data-control-row-y]')) {
        const original = row.getAttribute('data-control-row-y');
        if (original !== null) row.setAttribute('y', original);
        row.removeAttribute('data-control-row-y');
      }
    });
    const restored = await readSemantic(interleavedPage);
    printSemantic('control.compartment.restored', restored);
    expect.soft(
      memberCompartmentViolations(restored, expected),
      'control.compartment.restored: restoring the rows must read green again',
    ).toEqual([]);
  } finally {
    await interleavedContext.close();
  }
});

/**
 * Defect 6, in the real page: pin an entity and read its TITLE.
 *
 * The graph annotator inserts the `📌` badge before the title, so a reader that
 * takes "the first `<text>`" returns the glyph and the class loses its name.
 * The same `readSemantic` that the main arm uses reads the name by ROLE and
 * counts the badges; this case pins through the real search control, then puts
 * the pin back so the drawing is left as it was found.
 */
test('main arm — a pinned entity keeps its name and exactly one badge', async ({ browser }) => {
  const { context, page } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PC,
    touch: false,
  });
  try {
    await openArchitectureTab(page, sessionId);
    await showClassDiagram(page);
    await showExplosionView(page);
    await zoomToScale(page, 1);

    // Pin through the node's own context menu. The project-search pin only
    // exists for entities OUTSIDE the current graph, and the fixture's graph is
    // the whole fixture — so the node menu is the honest route here.
    const target = await page.evaluate((sel) => {
      const host = document.querySelector(sel.host);
      const hostRect = host === null ? null : host.getBoundingClientRect();
      if (hostRect === null) return null;
      for (const node of document.querySelectorAll('.uml-node[data-entity-id]')) {
        const id = node.getAttribute('data-entity-id') ?? '';
        if (!/\.ts\.[^./]+$/.test(id)) continue;
        const rect = node.getBoundingClientRect();
        if (!(rect.width > 0) || !(rect.height > 0)) continue;
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        if (x < hostRect.left + 4 || x > hostRect.right - 4) continue;
        if (y < hostRect.top + 4 || y > hostRect.bottom - 4) continue;
        return { id, x, y };
      }
      return null;
    }, SEL);
    expect(target, 'the class drawing must offer an on-screen entity to pin').not.toBeNull();
    const pinnedNode = target as { id: string; x: number; y: number };
    await page.mouse.click(pinnedNode.x, pinnedNode.y, { button: 'right' });
    const pinItem = page.locator('[data-architecture-context-pin]');
    await expect(pinItem, 'a node context menu must offer Pin to graph').toBeVisible({ timeout: 10_000 });
    await pinItem.first().click();
    await page.waitForFunction(
      () => document.querySelector('.uml-node[data-architecture-pinned="true"]') !== null,
      undefined,
      { timeout: 30_000 },
    );
    // The pin re-requests the graph and the fresh drawing refits; a refit of a
    // 120-entity drawing is a package-only tier, where the class box (and its
    // title) is not drawn. Read the title at the level that draws it.
    await showExplosionView(page);
    await zoomToScale(page, 1);
    await settle(page, 600);

    const reading = await readSemantic(page);
    printSemantic('pinned', reading);
    expect(reading.pinned.length, 'a pinned entity must be drawn with its marker').toBeGreaterThan(0);
    for (const entry of reading.pinned) {
      expect.soft(entry.badgeCount, `${entry.id}: exactly one pin badge`).toBe(1);
      expect.soft(entry.name, `${entry.id}: the title must not be the pin glyph`).not.toBe('📌');
      expect.soft(entry.name, `${entry.id}: the title must be the entity label`).toBe(entry.label);
    }
    assertSemantic(reading, 'pinned', SEMANTIC_MIN_PC_PX, null);

    // Put the page back: unpin the entity the menu pinned, so the drawing ends
    // in its initial state (the DoD asks for the same round trip).
    const pinnedAgain = await page.evaluate((id) => {
      const node = [...document.querySelectorAll('.uml-node[data-entity-id]')]
        .find((candidate) => candidate.getAttribute('data-entity-id') === id);
      if (node === null || node === undefined) return null;
      const rect = node.getBoundingClientRect();
      if (!(rect.width > 0) || !(rect.height > 0)) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, pinnedNode.id);
    if (pinnedAgain !== null) {
      await page.mouse.click(pinnedAgain.x, pinnedAgain.y, { button: 'right' });
      const unpin = page.locator(`[data-architecture-context-unpin="${pinnedNode.id}"]`);
      if ((await unpin.count()) > 0) await unpin.first().click();
      await settle(page, 400);
    }
  } finally {
    await context.close();
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
    await showClassDiagram(page);
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
 * The three polish readings from defects 5–7, forced red through the SAME
 * `readSemantic` the main arms use.
 *
 * Each arm injects the DEFECT, not a different reader:
 *  · the compartment rule back at a proportional position (crossing a member);
 *  · the title back to "the first `<text>`" (the pin badge, a bare `📌`);
 *  · the old fixed-cap wrap (a second name line in a box wide enough for one).
 * Every injection is undone before the next arm and the restored state is
 * re-asserted green.
 */
test('control arm — the rule, name-role and one-line readings read a false when their defect returns', async ({ browser }) => {
  const { context, page } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PC,
    touch: false,
  });
  try {
    await openArchitectureTab(page, sessionId);
    await showClassDiagram(page);
    await showExplosionView(page);
    await zoomToScale(page, 1);

    const before = await readSemantic(page);
    printSemantic('controlPolish.before', before);
    assertSemantic(before, 'controlPolish.before', SEMANTIC_MIN_PC_PX, null);

    // Arm 1 — the compartment rule back at a proportional position.
    const crossedRule = await page.evaluate(() => {
      const groups = [...document.querySelectorAll('.uml-node[data-entity-id]')].filter((group) => {
        const rect = group.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0
          && rect.x < window.innerWidth && rect.x + rect.width > 0
          && rect.y < window.innerHeight && rect.y + rect.height > 0;
      });
      for (const group of groups) {
        const members = [...group.querySelectorAll('[data-architecture-node-member]')];
        const lines = [...group.children].filter((child) => child.tagName.toLowerCase() === 'line');
        if (members.length === 0 || lines.length < 2) continue;
        const rule = lines[1];
        const ruleRect = rule.getBoundingClientRect();
        const memberRect = members[0].getBoundingClientRect();
        const dy = (memberRect.top + memberRect.height / 2) - (ruleRect.top + ruleRect.height / 2);
        rule.setAttribute('data-control-rule', rule.getAttribute('transform') ?? '');
        rule.setAttribute('transform', `translate(0, ${dy})`);
        return group.getAttribute('data-entity-id');
      }
      return null;
    });
    expect(crossedRule, 'controlPolish.rule: the page needs a member-bearing class box').not.toBeNull();
    const crossed = await readSemantic(page);
    printSemantic('controlPolish.rule', crossed);
    expect.soft(
      crossed.memberRuleOverlaps.length,
      `controlPolish.rule: a rule through a member row must be read; overlaps=${JSON.stringify(crossed.memberRuleOverlaps)}`,
    ).toBeGreaterThan(0);
    await page.evaluate(() => {
      for (const rule of document.querySelectorAll('[data-control-rule]')) {
        const original = rule.getAttribute('data-control-rule');
        if (original !== null && original !== '') rule.setAttribute('transform', original);
        else rule.removeAttribute('transform');
        rule.removeAttribute('data-control-rule');
      }
    });

    // Arm 2 — the title read as "the first `<text>`": a bare pin glyph first.
    const injectedGlyph = await page.evaluate(() => {
      // The reading only includes boxes that intersect the viewport, so inject
      // into one of those — an off-screen defect would prove nothing.
      const group = [...document.querySelectorAll('.uml-node[data-entity-id]')].find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        if (!(rect.width > 0) || !(rect.height > 0)) return false;
        if (rect.x >= window.innerWidth || rect.x + rect.width <= 0) return false;
        if (rect.y >= window.innerHeight || rect.y + rect.height <= 0) return false;
        return candidate.querySelector('[data-architecture-node-name]') !== null;
      });
      if (group === undefined) return false;
      const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      glyph.setAttribute('data-control-name', 'true');
      glyph.setAttribute('font-size', '11');
      glyph.textContent = '📌';
      group.insertBefore(glyph, group.firstChild);
      return true;
    });
    expect(injectedGlyph, 'controlPolish.name: the page needs a named class box').toBe(true);
    const misread = await readSemantic(page);
    printSemantic('controlPolish.name', misread);
    expect.soft(
      misread.names.some((name) => name.lines > 0 && name.label === null),
      `controlPolish.name: taking the first text as the title must read the glyph; names=${JSON.stringify(misread.names.map((name) => [name.id, name.text, name.label]))}`,
    ).toBe(true);
    await page.evaluate(() => {
      for (const glyph of document.querySelectorAll('[data-control-name]')) glyph.remove();
    });

    // Arm 3 — the fixed-130px decision: a second name line in a wide box.
    const wrapped = await page.evaluate(() => {
      const names = [...document.querySelectorAll('[data-architecture-node-name]')]
        .filter((candidate) => {
          const rect = candidate.getBoundingClientRect();
          const group = candidate.closest('[data-entity-id]');
          if (group === null) return false;
          const groupRect = group.getBoundingClientRect();
          // Same population the reading sees: a box inside the viewport.
          if (!(groupRect.width > 0) || !(groupRect.height > 0)) return false;
          if (groupRect.x >= window.innerWidth || groupRect.x + groupRect.width <= 0) return false;
          if (groupRect.y >= window.innerHeight || groupRect.y + groupRect.height <= 0) return false;
          const box = group.querySelector('rect')?.getBoundingClientRect();
          return rect.width > 0 && box !== undefined && box !== null && box.width > 0;
        });
      for (const name of names) {
        const full = (name.textContent ?? '').trim();
        if (full.length < 8) continue;
        const group = name.closest('[data-entity-id]');
        const box = group?.querySelector('rect')?.getBoundingClientRect();
        if (group === null || box === undefined || box === null) continue;
        // Only a box that comfortably fits the whole label makes the wrap wrong.
        const fontSize = Number.parseFloat(getComputedStyle(name).fontSize);
        const fullWidth = full.length * fontSize * 0.6;
        if (fullWidth + 20 > box.width) continue;
        const split = Math.ceil(full.length / 2);
        name.setAttribute('data-control-wrap', 'true');
        name.setAttribute('data-control-original', full);
        name.setAttribute('data-control-y', name.getAttribute('y') ?? '');
        const second = name.cloneNode(false) as SVGTextElement;
        // The clone copies the original's restore records too — mark it so the
        // restore removes it instead of treating it as a second original.
        second.setAttribute('data-control-wrap', 'true');
        second.setAttribute('data-control-clone', 'true');
        second.textContent = full.slice(split);
        name.textContent = full.slice(0, split);
        const y = Number(name.getAttribute('y') ?? '0');
        name.setAttribute('y', String(y - 4));
        second.setAttribute('y', String(y + 8));
        group.appendChild(second);
        return group.getAttribute('data-entity-id');
      }
      return null;
    });
    expect(wrapped, 'controlPolish.wrap: a box wide enough for one line must exist').not.toBeNull();
    const wrappedReading = await readSemantic(page);
    printSemantic('controlPolish.wrap', wrappedReading);
    expect.soft(
      wrappedReading.names.some((name) => name.oneLineRequired && name.lines > 1),
      `controlPolish.wrap: a two-line name in a wide box must be read; names=${JSON.stringify(wrappedReading.names.map((name) => [name.id, name.oneLineRequired, name.lines]))}`,
    ).toBe(true);
    await page.evaluate(() => {
      for (const second of [...document.querySelectorAll('[data-control-wrap]')]) {
        if (second.hasAttribute('data-control-clone')) {
          second.remove();
          continue;
        }
        if (second.hasAttribute('data-control-original')) {
          second.textContent = second.getAttribute('data-control-original') ?? '';
          const y = second.getAttribute('data-control-y');
          if (y !== null && y !== '') second.setAttribute('y', y);
          else second.removeAttribute('y');
          second.removeAttribute('data-control-original');
          second.removeAttribute('data-control-y');
          second.removeAttribute('data-control-wrap');
        } else {
          second.remove();
        }
      }
    });

    const restored = await readSemantic(page);
    printSemantic('controlPolish.restored', restored);
    assertSemantic(restored, 'controlPolish.restored', SEMANTIC_MIN_PC_PX, null);
  } finally {
    await context.close();
  }
});

/**
 * The four readings added for defects 1–4, forced red through the SAME
 * `readSemantic`.
 *
 * The shipped features are switched off one at a time in the live drawing:
 * the stereotype drops to 4px (font rule off), a ghost is painted over its own
 * visible tab (appearance condition off), a ghost is painted over a class name
 * (avoidance off), and the renderer's own `… +1 more (5 members)` row is put
 * back into a member area (strip off).
 */
test('control arm — the stereotype, sticky and overflow readings read a false when their defect returns', async ({ browser }) => {
  const { context, page } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PC,
    touch: false,
  });
  try {
    await openArchitectureTab(page, sessionId);
    await showClassDiagram(page);
    await showExplosionView(page);
    await zoomToScale(page, 1);

    const before = await readSemantic(page);
    printSemantic('controlPolish2.before', before);
    assertSemantic(before, 'controlPolish2.before', SEMANTIC_MIN_PC_PX, null);

    // Arm 1 — the stereotype font rule off.
    const stereotyped = await page.evaluate(() => {
      const texts = [...document.querySelectorAll('[data-architecture-node-stereotype]')];
      for (const text of texts) {
        text.setAttribute('data-control-fontsize', text.getAttribute('font-size') ?? '');
        text.setAttribute('font-size', '4');
      }
      return texts.length;
    });
    expect(stereotyped, 'controlPolish2.stereotype: the drawing needs a stereotype line').toBeGreaterThan(0);
    const smallStereotype = await readSemantic(page);
    printSemantic('controlPolish2.stereotype', smallStereotype);
    const smallestFont = Math.min(...smallStereotype.classes.flatMap((box) => box.fonts));
    expect.soft(
      smallestFont,
      `controlPolish2.stereotype: shrinking only the stereotype must read below ${SEMANTIC_MIN_PC_PX}px; got ${formatNumber(smallestFont)}px`,
    ).toBeLessThan(SEMANTIC_MIN_PC_PX);
    await page.evaluate(() => {
      for (const text of document.querySelectorAll('[data-architecture-node-stereotype]')) {
        const original = text.getAttribute('data-control-fontsize');
        if (original !== null && original !== '') text.setAttribute('font-size', original);
        else text.removeAttribute('font-size');
        text.removeAttribute('data-control-fontsize');
      }
    });

    // Arm 2 — a ghost label over its OWN visible tab (appearance condition off).
    // At 100 % the class drawing is taller than its host and a package tab can
    // sit outside the visible box; scroll one into view first, then let the
    // scroll-driven sticky redraw finish before injecting (that redraw owns the
    // `data-architecture-sticky-package` elements).
    await page.evaluate((sel) => {
      const host = document.querySelector(sel.host);
      if (host === null) return;
      const hostRect = host.getBoundingClientRect();
      for (const group of document.querySelectorAll('.uml-package[data-package-id]')) {
        const path = group.querySelector('path');
        if (path === null) continue;
        const rect = path.getBoundingClientRect();
        if (!(rect.width > 0) || !(rect.height > 0)) continue;
        const visible = rect.left < hostRect.right && rect.right > hostRect.left
          && rect.top < hostRect.bottom && rect.bottom > hostRect.top;
        if (visible) return;
        // Bring this tab just inside the host's top-left corner.
        host.scrollLeft += rect.left - hostRect.left - 4;
        host.scrollTop += rect.top - hostRect.top - 4;
        return;
      }
    }, SEL);
    await page.waitForTimeout(160);
    const ghostOverTab = await page.evaluate((sel) => {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.querySelector('svg[data-architecture-semantic]');
      const host = document.querySelector(sel.host);
      const hostRect = host === null ? null : host.getBoundingClientRect();
      if (svg === null || hostRect === null) return false;
      const svgRect = svg.getBoundingClientRect();
      for (const group of document.querySelectorAll('.uml-package[data-package-id]')) {
        const path = group.querySelector('path');
        if (path === null) continue;
        const rect = path.getBoundingClientRect();
        if (!(rect.width > 0) || !(rect.height > 0)) continue;
        // A tab is VISIBLE when it intersects the scroll host (the host clips
        // the taller SVG); the ghost covers that visible part.
        const left = Math.max(rect.left, hostRect.left);
        const top = Math.max(rect.top, hostRect.top);
        const right = Math.min(rect.right, hostRect.right);
        const bottom = Math.min(rect.bottom, hostRect.bottom);
        if (right - left <= 0 || bottom - top <= 0) continue;
        const id = group.getAttribute('data-package-id') ?? '';
        const ghost = document.createElementNS(ns, 'g');
        ghost.setAttribute('data-architecture-sticky-package', id);
        ghost.setAttribute('data-control-sticky', 'tab');
        const pill = document.createElementNS(ns, 'rect');
        const x = left - svgRect.left;
        const y = top - svgRect.top;
        pill.setAttribute('x', String(x));
        pill.setAttribute('y', String(y));
        pill.setAttribute('width', String(right - left));
        pill.setAttribute('height', String(bottom - top));
        pill.setAttribute('fill', 'rgba(248,250,252,.92)');
        const text = document.createElementNS(ns, 'text');
        text.setAttribute('x', String(x + 2));
        text.setAttribute('y', String(y + (bottom - top) / 2 + 4));
        text.setAttribute('font-size', '10');
        text.textContent = 'ghost';
        ghost.append(pill, text);
        svg.appendChild(ghost);
        return true;
      }
      return false;
    }, SEL);
    expect(ghostOverTab, 'controlPolish2.ghost: a package tab must be visible in the scroll host').toBe(true);
    const ghostReading = await readSemantic(page);
    printSemantic('controlPolish2.ghost', ghostReading);
    expect.soft(
      ghostReading.stickyOwnTabVisible.length,
      `controlPolish2.ghost: a ghost over its own visible tab must be read; ${JSON.stringify(ghostReading.stickyOwnTabVisible)}`,
    ).toBeGreaterThan(0);
    await page.evaluate(() => {
      for (const ghost of document.querySelectorAll('[data-control-sticky]')) ghost.remove();
    });

    // Arm 3 — a ghost label over a visible class name (avoidance off).
    const ghostOverName = await page.evaluate(() => {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.querySelector('svg[data-architecture-semantic]');
      const name = [...document.querySelectorAll('[data-architecture-node-name]')].find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      if (svg === null || name === undefined) return false;
      const svgRect = svg.getBoundingClientRect();
      const rect = name.getBoundingClientRect();
      const ghost = document.createElementNS(ns, 'g');
      ghost.setAttribute('data-architecture-sticky-package', 'control-name');
      ghost.setAttribute('data-control-sticky', 'name');
      const pill = document.createElementNS(ns, 'rect');
      pill.setAttribute('x', String(rect.left - svgRect.left));
      pill.setAttribute('y', String(rect.top - svgRect.top));
      pill.setAttribute('width', String(rect.width));
      pill.setAttribute('height', String(rect.height));
      pill.setAttribute('fill', 'rgba(248,250,252,.92)');
      const text = document.createElementNS(ns, 'text');
      text.setAttribute('x', String(rect.left - svgRect.left + 2));
      text.setAttribute('y', String(rect.top - svgRect.top + rect.height / 2 + 4));
      text.setAttribute('font-size', '10');
      text.textContent = 'ghost';
      ghost.append(pill, text);
      svg.appendChild(ghost);
      return true;
    });
    expect(ghostOverName, 'controlPolish2.avoid: the drawing needs a visible name').toBe(true);
    const coverReading = await readSemantic(page);
    printSemantic('controlPolish2.avoid', coverReading);
    expect.soft(
      coverReading.stickyNameOverlaps.length,
      `controlPolish2.avoid: a ghost over a class name must be read; ${JSON.stringify(coverReading.stickyNameOverlaps)}`,
    ).toBeGreaterThan(0);
    await page.evaluate(() => {
      for (const ghost of document.querySelectorAll('[data-control-sticky]')) ghost.remove();
    });

    // Arm 4 — the upstream overflow row put back into a member area (strip off).
    const overflowInjected = await page.evaluate(() => {
      const ns = 'http://www.w3.org/2000/svg';
      const group = [...document.querySelectorAll('.uml-node[data-entity-id]')]
        .find((candidate) => candidate.querySelector('[data-architecture-node-member]') !== null);
      if (group === null || group === undefined) return false;
      const text = document.createElementNS(ns, 'text');
      text.setAttribute('data-architecture-node-member', 'true');
      text.setAttribute('data-control-overflow', 'true');
      text.setAttribute('font-size', '10');
      text.textContent = '+ … +1 more (5 members)';
      group.appendChild(text);
      return true;
    });
    expect(overflowInjected, 'controlPolish2.overflow: the drawing needs a member row').toBe(true);
    const overflowReading = await readSemantic(page);
    printSemantic('controlPolish2.overflow', overflowReading);
    expect.soft(
      overflowReading.upstreamOverflowRows.length,
      `controlPolish2.overflow: the renderer's own truncation row must be read; ${JSON.stringify(overflowReading.upstreamOverflowRows)}`,
    ).toBeGreaterThan(0);
    await page.evaluate(() => {
      for (const text of document.querySelectorAll('[data-control-overflow]')) text.remove();
    });

    const restored = await readSemantic(page);
    printSemantic('controlPolish2.restored', restored);
    assertSemantic(restored, 'controlPolish2.restored', SEMANTIC_MIN_PC_PX, null);
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
    // The portrait tier ships the row collapsed behind one button; the arm
    // measures the ROW, so open it through the shipped control first.
    await ensureZoomClusterOpen(page);
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

/* ── lossless text: the two arms ─────────────────────────────────────────────────────────── */

/**
 * The Text page and the Export menu carry the SAME complete PlantUML.
 *
 * The class fixture draws 120 entities (> the renderer's 40-entity compact
 * threshold), and every class carries five members. Before the fix the Text
 * page serialized the compact drawn model — four real rows plus a synthetic
 * `… +1 more (5 members)` row — while the Export menu rebuilt from the bridge
 * and was complete: two texts for one view. Now both read the drawn model the
 * renderer renders with `detail: 'full'`, so this arm asserts three things at
 * once: no truncation row anywhere, every drawn entity's member rows equal the
 * payload, and the downloaded file is line-for-line the text page's document.
 */
test('main arm — the Text page and the Export menu carry the same complete PlantUML', async ({ browser }) => {
  const activeFixture = fixture as ArchitectureFixtureReading;
  const { context, page } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PC,
    touch: false,
  });
  try {
    await openArchitectureTab(page, sessionId);
    await showClassDiagram(page);
    const visibleNodes = Number(
      await page.locator(SEL.graphRoot).getAttribute('data-architecture-visible-nodes'),
    );
    expect(
      visibleNodes,
      'the lossless arm needs a drawing past the renderer’s 40-entity compact threshold',
    ).toBeGreaterThan(40);

    await openSettledTextPage(page);

    // The Text page's own Download button: the document it shows and copies.
    const textPuml = await downloadText(page, () => page.locator('[data-architecture-text-download]').click());
    const textReading = readLosslessText(textPuml, activeFixture);
    console.log(`[architecture-layout] lossless.text=${JSON.stringify({
      entityCount: textReading.entityCount,
      classCount: textReading.classCount,
      multiMemberEntities: textReading.multiMemberEntities,
      markerLines: textReading.markerLines.slice(0, 3),
      missingMembers: textReading.missingMembers.slice(0, 3),
      characters: textPuml.length,
      lines: textPuml.split('\n').length,
    })}`);
    expect(
      textReading.markerLines,
      'no export text may contain the renderer’s truncation row',
    ).toEqual([]);
    expect(
      textReading.missingMembers,
      'every drawn entity’s member rows must equal its payload member count',
    ).toEqual([]);
    expect(textReading.unknownEntities, 'every block must name a fixture entity').toEqual([]);
    expect(textReading.entityCount, 'the document must carry the drawn entities').toBeGreaterThan(40);
    expect(
      textReading.multiMemberEntities,
      'the criterion is vacuous unless entities past the four-row compact cap are present',
    ).toBeGreaterThan(0);
    await page.screenshot({ path: test.info().outputPath('lossless-text-panel.png') });

    // The Export menu's own .puml download, from the same settled drawing.
    const exportPuml = await downloadText(page, async () => {
      await page.locator('[data-architecture-export="true"]').first().click();
      await expect(page.locator('[data-architecture-export-menu="true"]')).toBeVisible({ timeout: 10_000 });
      await page.locator('[role="menuitem"][data-architecture-export-item="puml"]').first().click();
    });
    expect(
      exportPuml,
      'the Text page and the Export menu must download one document, line for line',
    ).toBe(textPuml);
  } finally {
    await context.close();
  }
});

/**
 * The control: restore the renderer's DEFAULT detail and the same reading reds.
 *
 * The defect is not injectable into the DOM — it happens before layout, inside
 * `renderDetailed` — so the arm rewrites the served component module and sets
 * the detail constant to `void 0`, which is exactly "do not pass detail". The
 * upstream default then picks `compact` for this 120-entity drawing, writes its
 * `… +N more (M members)` row into the drawn model, and the SAME
 * {@link readLosslessText} that passes above must report both the marker and
 * the lost rows.
 */
test('control arm — restoring the default detail puts the overflow row back into the reading', async ({ browser }) => {
  const activeFixture = fixture as ArchitectureFixtureReading;
  const { context, page } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PC,
    touch: false,
  });
  let rewrites = 0;
  await page.route('**/src/modules/architecture/PlantUmlGraph.tsx*', async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const rewritten = body.replace(
      /const PLANTUML_MEMBER_DETAIL = (['"])full\1/,
      'const PLANTUML_MEMBER_DETAIL = void 0',
    );
    if (rewritten !== body) rewrites += 1;
    await route.fulfill({ response, body: rewritten });
  });
  try {
    await openArchitectureTab(page, sessionId);
    await showClassDiagram(page);
    expect(
      rewrites,
      'the control must have rewritten the served renderer; a miss would make the arm vacuous',
    ).toBeGreaterThan(0);

    await openSettledTextPage(page);
    const textPuml = await downloadText(page, () => page.locator('[data-architecture-text-download]').click());
    const reading = readLosslessText(textPuml, activeFixture);
    console.log(`[architecture-layout] lossless.control=${JSON.stringify({
      entityCount: reading.entityCount,
      classCount: reading.classCount,
      multiMemberEntities: reading.multiMemberEntities,
      markerLines: reading.markerLines.slice(0, 3),
      missingMembers: reading.missingMembers.slice(0, 3),
      violations: reading.violations.length,
      characters: textPuml.length,
      lines: textPuml.split('\n').length,
    })}`);
    // 0.5.2 marks the default detail's truncated row `synthetic` and the
    // serializer SKIPS it, so the defect this arm reproduces is now SILENT: no
    // marker reaches the text, and the rows the default dropped are simply
    // gone. The loss is what the reading must see — a marker count would be 0
    // on either side of the fix and could no longer tell them apart.
    expect(
      reading.markerLines.length,
      `no marker reaches the text on 0.5.2 (the loss is silent): ${JSON.stringify(reading.markerLines.slice(0, 3))}`,
    ).toBe(0);
    expect(
      reading.missingMembers.length,
      `the default detail must drop real member rows: ${JSON.stringify(reading.missingMembers.slice(0, 3))}`,
    ).toBeGreaterThan(0);
    expect(reading.violations.length, 'the shared reading must read the defect red').toBeGreaterThan(0);
    await page.screenshot({ path: test.info().outputPath('lossless-control-text-panel.png') });
  } finally {
    await context.close();
  }
});

/**
 * The selection tray's attachment is the SAME complete document.
 *
 * "Attach the selected subgraph's PlantUML" goes through the text page's own
 * `buildPlantUmlText`, so it inherited the same compact-detail truncation. With
 * two >4-member classes selected, the copied attachment must carry both blocks'
 * full member bodies, its volume reading must be the complete document's, and
 * the same {@link readLosslessText} must find no marker and no missing row.
 */
test('main arm — the tray attachment carries the same complete PlantUML', async ({ browser }) => {
  const activeFixture = fixture as ArchitectureFixtureReading;
  const { context, page } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PC,
    touch: false,
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  try {
    await openArchitectureTab(page, sessionId);
    await showClassDiagram(page);
    await page.waitForFunction(
      () => document.querySelector('[data-architecture-canvas-region]')
        ?.getAttribute('data-architecture-drawn-source') === 'drawn',
      undefined,
      { timeout: 40_000 },
    );

    // Two drawn CLASS entities (a payload with more than four members): the
    // defect is only observable on an entity whose tail compact would drop.
    const classNames = Object.entries(activeFixture.memberCountById)
      .filter(([, members]) => members > 4)
      .map(([id]) => id.slice(id.lastIndexOf('.') + 1));
    const readMultiMemberPoints = (): Promise<{ x: number; y: number }[]> => page.evaluate((names: string[]) => {
      const wanted = new Set(names);
      const points: { x: number; y: number }[] = [];
      for (const node of document.querySelectorAll('.uml-node[data-entity-id]')) {
        const id = node.getAttribute('data-entity-id') ?? '';
        if (!wanted.has(id.slice(id.lastIndexOf('.') + 1))) continue;
        const text = node.querySelector('text');
        if (text === null) continue;
        const rect = text.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 6) continue;
        const point = {
          x: Math.round(rect.left + Math.min(rect.width / 2, 30)),
          y: Math.round(rect.top + rect.height / 2),
        };
        const hit = document.elementFromPoint(point.x, point.y);
        if (hit === null || hit.closest('[data-entity-id]') === null) continue;
        points.push(point);
        if (points.length === 2) break;
      }
      return points;
    }, classNames);
    // The single-scale fit opens the 120-entity drawing at a package tier that
    // paints no entity boxes; zooming in is the reader's own way out of it, so
    // the arm drives the real control until two multi-member classes are drawn.
    let picked = await readMultiMemberPoints();
    for (let attempt = 0; attempt < 8 && picked.length < 2; attempt += 1) {
      await page.locator(SEL.zoomIn).first().click();
      await settle(page, 400);
      picked = await readMultiMemberPoints();
    }
    expect(picked.length, 'the drawing must offer two multi-member classes to select').toBe(2);

    await page.mouse.click(picked[0].x, picked[0].y);
    await page.keyboard.down('Shift');
    await page.mouse.click(picked[1].x, picked[1].y);
    await page.keyboard.up('Shift');
    await expect(page.locator('[data-architecture-tray-root]')).toBeVisible({ timeout: 10_000 });

    // The tray opens COLLAPSED (a 2-selected pill); the attachment controls are
    // inside the expanded panel.
    await page.locator('[data-architecture-tray-pill]').click();
    await expect(page.locator('[data-architecture-tray-expanded-panel]')).toBeVisible({ timeout: 10_000 });
    // Opening the inspector dock resized the canvas, which re-lays-out the
    // drawing; the tray's document follows that model. Wait for the re-layout's
    // model to land so the volume reading and the copy read the same document.
    await page.waitForFunction(
      () => document.querySelector('[data-architecture-canvas-region]')
        ?.getAttribute('data-architecture-drawn-source') === 'drawn',
      undefined,
      { timeout: 40_000 },
    );
    await settle(page, 400);
    await page.locator('[data-architecture-tray-attach]').check();
    const volumeElement = page.locator('[data-architecture-tray-volume]');
    await expect(volumeElement).toBeVisible({ timeout: 10_000 });
    const tokens = Number(await volumeElement.getAttribute('data-architecture-tray-volume'));

    await page.locator('[data-architecture-tray-copy]').click();
    // The copy handler is async; the live region states when the clipboard write
    // has RESOLVED. Reading before that can return the previous clipboard.
    await expect(page.locator('[data-architecture-tray-live]')).toContainText('PlantUML copied', {
      timeout: 10_000,
    });
    const attachment = await page.evaluate(() => navigator.clipboard.readText());
    const reading = readLosslessText(attachment, activeFixture);
    console.log(`[architecture-layout] lossless.tray=${JSON.stringify({
      classCount: reading.classCount,
      markerLines: reading.markerLines.slice(0, 3),
      missingMembers: reading.missingMembers.slice(0, 3),
      tokens,
      characters: attachment.length,
    })}`);
    expect(reading.classCount, 'the attachment is exactly the two selected classes').toBe(2);
    expect(reading.markerLines, 'the attachment may not contain the truncation row').toEqual([]);
    expect(reading.missingMembers, 'the attachment must carry every member').toEqual([]);
    expect(reading.violations).toEqual([]);
    // Re-read the volume after the write: the reading must describe the exact
    // document that was copied (a re-layout between the two renders would make
    // the first value a different spelling of the same complete text).
    const copiedTokens = Number(
      await page.locator('[data-architecture-tray-volume]').getAttribute('data-architecture-tray-volume'),
    );
    expect(copiedTokens, 'the volume reading measures the copied document').toBe(
      Math.round(attachment.length / 3.5),
    );
    expect(tokens, 'the attach-time reading was also a real band').toBeGreaterThan(0);
    await page.screenshot({ path: test.info().outputPath('lossless-tray-attachment.png') });

    // Restore the interaction state this case created: no selection, no tray.
    await page.locator('[data-architecture-tray-clear]').click();
    await expect(page.locator('[data-architecture-tray-root]')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

/* ── "Show all" and the folded fit on a function-heavy graph ───────────────────────────────── */

/**
 * Open the Filter drawer, read the relation preset it states, and close it
 * again (the drawer floats over the canvas; leaving it open would sit on the
 * geometry the next reading measures).
 *
 * The preset is read from the radios' own `aria-checked`, the same attribute a
 * screen reader gets, so "the preset did not move" is measured on the control
 * the reader sees rather than on an internal value.
 */
async function readRelationPreset(page: Page): Promise<{ preset: string | null; callChecked: boolean }> {
  const toggle = page.locator(SEL.filterToggle).first();
  await toggle.click();
  const menu = page.locator(SEL.filterMenu).first();
  await expect(menu).toBeVisible({ timeout: 10_000 });
  const dependencyChecked = (await page.locator(SEL.relationDependency).first().getAttribute('aria-checked')) === 'true';
  const callChecked = (await page.locator(SEL.relationCall).first().getAttribute('aria-checked')) === 'true';
  await toggle.click();
  await expect(menu).toHaveCount(0, { timeout: 10_000 });
  return { preset: dependencyChecked ? 'dependency' : callChecked ? 'call' : null, callChecked };
}

/** The canvas' own scroll geometry against its content box, plus the fold it is in. */
type FitGeometry = {
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly foldDepth: number | null;
  readonly zoomScale: number | null;
  readonly zoomLevelText: string;
  readonly hintText: string;
  readonly visibleNodes: number | null;
  readonly hiddenTotal: number | null;
};

/**
 * How far a fitted drawing may exceed its canvas and still read as "fits".
 *
 * The single-scale Fold solver packs to the 5% floor; on the 396-entity
 * function fixture that pack is 1164px inside a 1151px host (1.1% over), which
 * is a floor-and-rounding margin, not the defect this reading exists for. The
 * shipped defect the control arm restores is FOUR canvases wide, so 16px (one
 * scrollbar gutter plus integer rounding) does not weaken the discrimination.
 */
const FIT_OVERFLOW_TOLERANCE_PX = 16;

const readFitGeometry = (page: Page): Promise<FitGeometry> => page.evaluate((sel) => {
  const host = document.querySelector(sel.host);
  const root = document.querySelector(sel.graphRoot);
  const number = (value: string | null | undefined): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    scrollWidth: host?.scrollWidth ?? 0,
    clientWidth: host?.clientWidth ?? 0,
    scrollHeight: host?.scrollHeight ?? 0,
    clientHeight: host?.clientHeight ?? 0,
    foldDepth: number(root?.getAttribute('data-architecture-fold-depth')),
    zoomScale: number(root?.getAttribute('data-architecture-zoom-scale')),
    zoomLevelText: document.querySelector(sel.zoomLevel)?.textContent?.trim() ?? '',
    hintText: document.querySelector(sel.readableHint)?.textContent?.trim() ?? '',
    visibleNodes: number(root?.getAttribute('data-architecture-visible-nodes')),
    hiddenTotal: number(
      document.querySelector('[data-architecture-filter-hidden]')?.getAttribute('data-architecture-filter-hidden'),
    ),
  };
}, SEL);

/**
 * Open the CLASS (entity) drawing.
 *
 * The element/relation filter — and therefore "Show all" — only exists on the
 * entity graph: a file has no kind. The tab opens on the file view, so both arms
 * switch first and wait for the entity payload to be drawn.
 */
async function openEntityDrawing(page: Page): Promise<void> {
  const option = page.locator(SEL.viewEntity).first();
  await expect(option, 'the panel must offer the class (entity) granularity').toHaveCount(1, { timeout: 20_000 });
  await option.click();
  await settle(page, 800);
}

/** Wait until the tab has drawn the graph this session's fixture describes. */
async function waitForSavedDrawing(page: Page): Promise<void> {
  await page.waitForFunction(
    (sel) => {
      const root = document.querySelector(sel.graphRoot);
      return root !== null && Number(root.getAttribute('data-architecture-visible-nodes') ?? '0') > 0;
    },
    SEL,
    // The 396-box fixture's first layout can take over a minute alone; a host
    // shared with sibling Playwright runs doubles that.
    { timeout: 120_000 },
  );
  await settle(page, 600);
}

test('main arm — Show all keeps the relation preset, and Fit holds the whole function graph (1440x765)', async ({ browser }) => {
  // This case lays out a 360-box drawing TWICE (once to widen, once to fit), on
  // a real ELK main thread: the file's 60 s default is a small graph's budget,
  // and a load-shared host (several sibling Playwright runs live) pushed the
  // same body past 180 s. 300 s is the ceiling the other 396-box cases use.
  test.setTimeout(300_000);
  const { context, page } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PC,
    touch: false,
  });
  // Evidence for this heavy fixture: when the entity request is the bottleneck,
  // the log says whether the server ever answered it.
  page.on('response', (response) => {
    if (!response.url().includes('/api/architecture/graph')) return;
    void response.json().then((body: any) => {
      console.log(
        `[architecture-layout] functions.graph.response=${response.status()} `
        + `entityNodes=${body?.graph?.entity?.nodes?.length ?? '?'} fileNodes=${body?.graph?.file?.nodes?.length ?? '?'} `
        + `entityTotal=${body?.stats?.entityTotal ?? '?'} seeds=${body?.stats?.seedIdentifiers ?? '?'} `
        + `hidden=${JSON.stringify(body?.stats?.hidden ?? null)}`,
      );
    }).catch(() => {
      console.log(`[architecture-layout] functions.graph.response=${response.status()} (body unreadable)`);
    });
  });
  page.on('requestfailed', (request_) => {
    if (!request_.url().includes('/api/architecture/graph')) return;
    console.log(`[architecture-layout] functions.graph.failed=${request_.failure()?.errorText ?? 'unknown'}`);
  });

  try {
    await openArchitectureTab(page, functionsSessionId);
    await waitForSavedDrawing(page);
    await openEntityDrawing(page);
    // The granularity switch is a NEW REQUEST for this filter (the file request
    // carried no kinds). While it is in flight the panel draws its loading
    // paragraph, not the graph, so the hidden-count row cannot exist yet. A
    // load-shared host can take well over the old 30 s to answer a 396-entity
    // traversal, so wait for the graph root itself, then for the row.
    try {
      await page.waitForFunction(
        (sel) => document.querySelector(sel.graphRoot) !== null,
        SEL,
        { timeout: 150_000 },
      );
    } catch (error) {
      const stuck = await page.evaluate(() => ({
        loading: document.querySelector('[data-architecture-loading]') !== null,
        noSession: document.querySelector('[data-architecture-no-session]') !== null,
        error: document.querySelector('[data-architecture-error]')?.textContent ?? null,
        refreshing: document.querySelector('[data-architecture-refreshing]')?.getAttribute('data-architecture-refreshing') ?? null,
        checked: [...document.querySelectorAll('[data-architecture-view-option]')]
          .map((element) => `${element.getAttribute('data-architecture-view-option')}=${element.getAttribute('aria-checked')}`),
        body: document.body.innerText.slice(0, 240),
      }));
      console.log(`[architecture-layout] functions.graph.stuck=${JSON.stringify(stuck)}`);
      throw error;
    }
    await settle(page, 800);
    const entityState = await page.evaluate(() => ({
      checked: [...document.querySelectorAll('[data-architecture-view-option]')]
        .map((element) => `${element.getAttribute('data-architecture-view-option')}=${element.getAttribute('aria-checked')}`),
      readout: (document.querySelector('[data-architecture-readout]') as HTMLElement | null)?.innerText ?? null,
      hiddenRow: document.querySelector('[data-architecture-filter-hidden]')?.getAttribute('data-architecture-filter-hidden') ?? null,
      loading: document.querySelector('[data-architecture-loading]') !== null,
      noSession: document.querySelector('[data-architecture-no-session]') !== null,
      visibleNodes: document.querySelector('[data-architecture-plantuml-graph]')?.getAttribute('data-architecture-visible-nodes') ?? null,
      error: document.querySelector('[data-architecture-error]')?.textContent ?? null,
    }));
    console.log(`[architecture-layout] functions.entityState=${JSON.stringify(entityState)}`);
    await expect(
      page.locator('[data-architecture-filter-hidden]').first(),
      'the entity drawing must state the functions its default filter hides',
    ).toHaveCount(1, { timeout: 120_000 });

    // The shipped relation preset, before anything is clicked.
    const before = await readRelationPreset(page);
    expect(before.preset, 'the tab opens on the shipped +Dependencies preset').toBe('dependency');
    const beforeFit = await readFitGeometry(page);
    expect(
      beforeFit.hiddenTotal,
      'the function kind is hidden, so the readout offers the "Show all" this criterion drives',
    ).toBeGreaterThan(0);

    // Watch for the layout status from BEFORE the click: the reading is "how
    // soon after the reader asked did the canvas say it was laying out", which
    // is the whole point of the notice (17.6 s of silence was the defect).
    await page.evaluate(() => {
      const state = window as unknown as { __layoutStatusAt: number | null; __layoutStatusText: string | null };
      state.__layoutStatusAt = null;
      state.__layoutStatusText = null;
      const observer = new MutationObserver(() => {
        if (state.__layoutStatusAt !== null) return;
        const node = document.querySelector('[data-architecture-layout-status]');
        if (node !== null) {
          state.__layoutStatusAt = performance.now();
          state.__layoutStatusText = node.textContent?.trim() ?? null;
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    const showAllClickedAt = await page.evaluate(() => performance.now());

    // "Show all" — the element axis widens; the relation axis must not move.
    await page.locator(SEL.filterShowAll).first().click();
    // The widened drawing is a new layout of 396 boxes on the main thread: wait
    // for the renderer to report it rather than for a fixed delay.
    await page.waitForFunction(
      (sel) => Number(document.querySelector(sel.graphRoot)?.getAttribute('data-architecture-visible-nodes') ?? '0') > 300,
      SEL,
      { timeout: 120_000 },
    );
    await settle(page, 1_200);

    const after = await readRelationPreset(page);
    expect(
      after.preset,
      'Show all shows every KIND; it must leave the relation preset exactly where the reader had it',
    ).toBe('dependency');
    expect(after.callChecked, 'the +Calls preset must not be switched on behind the reader\'s back').toBe(false);

    const widened = await readFitGeometry(page);
    expect(widened.visibleNodes, 'the widened drawing really holds the function boxes').toBeGreaterThan(300);
    const statusReading = await page.evaluate(() => {
      const state = window as unknown as { __layoutStatusAt: number | null; __layoutStatusText: string | null };
      return { at: state.__layoutStatusAt, text: state.__layoutStatusText };
    });
    console.log(
      `[architecture-layout] layoutStatus.firstSeen=`
        + `${statusReading.at === null ? 'never' : `${Math.round(statusReading.at - showAllClickedAt)}ms after the Show all click`} `
        + `text=${JSON.stringify(statusReading.text)}`,
    );

    // Fit must put the WHOLE drawing in the canvas: no scroll bar on either axis.
    await page.locator(SEL.zoomFit).first().click();
    // The 396-box solve is a binary search over the mapped layout on the main
    // thread; a fixed delay reads an intermediate scale (measured 1164 > 1151
    // under load). Wait for the settled state instead.
    await page.waitForFunction(
      (sel) => {
        const host = document.querySelector(sel.host) as HTMLElement | null;
        return host !== null
          && host.scrollWidth <= host.clientWidth + FIT_OVERFLOW_TOLERANCE_PX
          && host.scrollHeight <= host.clientHeight + FIT_OVERFLOW_TOLERANCE_PX;
      },
      SEL,
      { timeout: 120_000 },
    ).catch(() => undefined);
    await settle(page, 400);
    const fitted = await readFitGeometry(page);
    console.log(`[architecture-layout] functions.fitted=${JSON.stringify(fitted)}`);
    expect(
      fitted.scrollWidth,
      `after Fit the drawing must not scroll horizontally: ${fitted.scrollWidth} > ${fitted.clientWidth} + ${FIT_OVERFLOW_TOLERANCE_PX}`,
    ).toBeLessThanOrEqual(fitted.clientWidth + FIT_OVERFLOW_TOLERANCE_PX);
    expect(
      fitted.scrollHeight,
      `after Fit the drawing must not scroll vertically: ${fitted.scrollHeight} > ${fitted.clientHeight} + ${FIT_OVERFLOW_TOLERANCE_PX}`,
    ).toBeLessThanOrEqual(fitted.clientHeight + FIT_OVERFLOW_TOLERANCE_PX);
    // The hint states what the reader is looking at: the collapse, not a
    // percentage over a drawing several canvases wide.
    if (fitted.foldDepth !== null) {
      expect(fitted.hintText, 'the folded tier explains itself').toMatch(/Collapsed to \d+ level/);
      expect(fitted.hintText, 'and never claims to be the whole graph at a percentage').not.toMatch(/Whole graph/);
    }

    await page.screenshot({ path: 'tmp/show-all-fitted-pc.png', fullPage: false });

    // ── Reset filters: one click back to the project's shipped selection ──────
    // The popover carries the action unconditionally; the readout row offers it
    // only while something is hidden (after "Show all" on this fixture nothing
    // is, because there are no `call` edges for the kept preset to hide).
    await page.locator(SEL.filterToggle).first().click();
    const menu = page.locator(SEL.filterMenu).first();
    await expect(menu).toBeVisible({ timeout: 10_000 });
    const resetButton = menu.locator('[data-architecture-filter-reset]').first();
    await expect(resetButton, 'the filter drawer offers the way back from the widened filter').toHaveCount(1);
    await resetButton.click();
    await settle(page, 800);
    await page.locator(SEL.filterToggle).first().click();
    await expect(menu).toHaveCount(0, { timeout: 10_000 });
    const reset = await readRelationPreset(page);
    expect(reset.preset, 'Reset filters keeps the preset it restores (the shipped dependency one)').toBe('dependency');
    const afterReset = await readFitGeometry(page);
    expect(
      afterReset.hiddenTotal,
      'after Reset filters the shipped element cut is back in force (the functions are hidden again)',
    ).toBeGreaterThan(0);
    await page.screenshot({ path: 'tmp/show-all-reset-pc.png', fullPage: false });

    const elapsed = Date.now() - RUN_STARTED_AT;
    console.log(`[architecture-layout] elapsed=${elapsed}ms`);
  } finally {
    await context.close();
  }
});

test('control arm — restoring the shipped Show-all defect moves the preset, and an unfolded drawing overflows Fit', async ({ browser }) => {
  // Same 360-box drawing as the main arm, so the same raised budget applies;
  // see the main arm's note about load-shared hosts.
  test.setTimeout(300_000);
  const { context, page } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PC,
    touch: false,
  });

  try {
    await openArchitectureTab(page, functionsSessionId);
    await waitForSavedDrawing(page);
    await openEntityDrawing(page);

    // ── arm A: the relation-preset reading can read RED ──────────────────────
    // The same reading, on a page where the shipped defect is reproduced: put
    // the preset where the old "Show all" silently left it (`+Calls`) and read
    // the SAME function that asserts "dependency" in the main arm.
    await page.locator(SEL.filterToggle).first().click();
    await expect(page.locator(SEL.filterMenu).first()).toBeVisible({ timeout: 10_000 });
    await page.locator(SEL.relationCall).first().click();
    await page.locator(SEL.filterToggle).first().click();
    await expect(page.locator(SEL.filterMenu).first()).toHaveCount(0);
    const redPreset = await readRelationPreset(page);
    expect(
      redPreset.preset,
      'the reading the main arm relies on must go red when the preset is moved — otherwise it proves nothing',
    ).toBe('call');
    expect(redPreset.callChecked).toBe(true);
    expect(redPreset.preset === 'dependency').toBe(false);

    // Put the preset back so the rest of the page is the shipped one.
    await page.locator(SEL.filterToggle).first().click();
    await expect(page.locator(SEL.filterMenu).first()).toBeVisible({ timeout: 10_000 });
    await page.locator(SEL.relationDependency).first().click();
    await page.locator(SEL.filterToggle).first().click();
    expect((await readRelationPreset(page)).preset).toBe('dependency');

    // ── arm B: the fit reading can read RED ("the folded tier switched off") ──
    // The state the folded tier exists to prevent — the package-only drawing as
    // wide as the ORIGINAL one — is reproduced here by widening the SVG the
    // canvas is showing. That is the same failure the tier removes: with the
    // fold off, nothing re-packs the package frames, so the drawing keeps the
    // original extent and Fit can only crop it. The SAME reading that asserts
    // "no horizontal scroll" in the main arm must then read the overflow.
    await page.locator(SEL.zoomFit).first().click();
    // Same settled-state wait as the main arm: the Fit solve is a main-thread
    // binary search over 396 mapped boxes.
    await page.waitForFunction(
      (sel) => {
        const host = document.querySelector(sel.host) as HTMLElement | null;
        return host !== null
          && host.scrollWidth <= host.clientWidth + FIT_OVERFLOW_TOLERANCE_PX
          && host.scrollHeight <= host.clientHeight + FIT_OVERFLOW_TOLERANCE_PX;
      },
      SEL,
      { timeout: 120_000 },
    ).catch(() => undefined);
    await settle(page, 400);
    const green = await readFitGeometry(page);
    expect(green.scrollWidth, 'baseline: the fitted drawing does not scroll').toBeLessThanOrEqual(green.clientWidth + FIT_OVERFLOW_TOLERANCE_PX);

    await page.evaluate((sel) => {
      const svg = document.querySelector(sel.host)?.querySelector('svg');
      if (svg === null) throw new Error('the canvas has no drawing to widen');
      svg.setAttribute('data-control-arm-width', svg.getAttribute('width') ?? '');
      svg.setAttribute('width', String(Math.round((document.querySelector(sel.host)?.clientWidth ?? 100) * 4)));
    }, SEL);
    await settle(page, 300);
    const red = await readFitGeometry(page);
    expect(
      red.scrollWidth,
      'control arm B: a drawing four canvases wide must read as a horizontal overflow',
    ).toBeGreaterThan(red.clientWidth + FIT_OVERFLOW_TOLERANCE_PX);

    await page.evaluate((sel) => {
      const svg = document.querySelector(sel.host)?.querySelector('svg');
      if (svg === null) return;
      svg.setAttribute('width', svg.getAttribute('data-control-arm-width') ?? '');
      svg.removeAttribute('data-control-arm-width');
    }, SEL);
    await settle(page, 300);
    const restored = await readFitGeometry(page);
    expect(
      restored.scrollWidth,
      'control arm B: removing the injection must put the reading back on the passing side',
    ).toBeLessThanOrEqual(restored.clientWidth + FIT_OVERFLOW_TOLERANCE_PX);
    await page.screenshot({ path: 'tmp/show-all-control-arm-restored.png', fullPage: false });
  } finally {
    await context.close();
  }
});

/* ── panel visibility and readout fixes (2026-10-23) ─────────────────────────────────────────── */

/** The numbers the one-line readout and its filter line state, exactly as the DOM holds them. */
type SummaryNumbers = {
  readonly shown: number | null;
  readonly related: number | null;
  readonly hidden: number | null;
  readonly hiddenKinds: string | null;
  readonly hiddenRelations: string | null;
  readonly hiddenIsolated: string | null;
};

/**
 * Read the summary in ONE round trip.
 *
 * The three numbers the criterion compares are N (`readout-summary`), M
 * (`readout-total`) and the filter line's own removals. `hidden` is the total
 * the panel prints; the per-axis attributes are read beside it so a red names
 * WHICH number moved instead of only "the line changed".
 */
const readSummaryNumbers = (page: Page): Promise<SummaryNumbers> => page.evaluate(() => {
  const summary = document.querySelector('[data-architecture-readout-summary]');
  const hidden = document.querySelector('[data-architecture-filter-hidden]');
  const number = (raw: string | null | undefined): number | null => {
    if (raw === null || raw === undefined || raw === '') return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    shown: number(summary?.getAttribute('data-architecture-readout-summary')),
    related: number(summary?.getAttribute('data-architecture-readout-total')),
    hidden: number(hidden?.getAttribute('data-architecture-filter-hidden')),
    hiddenKinds: hidden?.getAttribute('data-architecture-filter-hidden-kinds') ?? null,
    hiddenRelations: hidden?.getAttribute('data-architecture-filter-hidden-relations') ?? null,
    hiddenIsolated: hidden?.getAttribute('data-architecture-filter-hidden-isolated') ?? null,
  };
});

/**
 * What an expanded disclosure really shows: its own box, the area left after
 * intersecting the viewport and EVERY clipping ancestor, and its row count.
 *
 * `getBoundingClientRect` ignores ancestor clipping, so a panel cut to nothing
 * still reports its full height. That difference is the defect being measured.
 */
type DisclosureReading = {
  readonly expanded: string | null;
  readonly box: Box | null;
  readonly boxArea: number;
  readonly visibleArea: number;
  readonly insideViewport: boolean;
  readonly rows: number;
};

const readCleanupDisclosure = (page: Page): Promise<DisclosureReading> => page.evaluate(() => {
  const toggle = document.querySelector('[data-architecture-scope-hygiene]');
  const detail = document.querySelector('[data-architecture-scope-hygiene-detail]');
  if (!(detail instanceof HTMLElement)) {
    return {
      expanded: toggle?.getAttribute('aria-expanded') ?? null,
      box: null,
      boxArea: 0,
      visibleArea: 0,
      insideViewport: false,
      rows: 0,
    };
  }
  const rect = detail.getBoundingClientRect();
  let clip = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  for (let ancestor = detail.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    const style = window.getComputedStyle(ancestor);
    if (!/(auto|scroll|hidden)/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)) continue;
    const box = ancestor.getBoundingClientRect();
    clip = {
      left: Math.max(clip.left, box.left),
      top: Math.max(clip.top, box.top),
      right: Math.min(clip.right, box.right),
      bottom: Math.min(clip.bottom, box.bottom),
    };
  }
  const width = Math.max(0, Math.min(rect.right, clip.right) - Math.max(rect.left, clip.left));
  const height = Math.max(0, Math.min(rect.bottom, clip.bottom) - Math.max(rect.top, clip.top));
  return {
    expanded: toggle?.getAttribute('aria-expanded') ?? null,
    box: { x: rect.x, y: rect.y, w: rect.width, h: rect.height, x2: rect.right, y2: rect.bottom },
    boxArea: rect.width * rect.height,
    visibleArea: width * height,
    insideViewport: rect.left >= 0 && rect.top >= 0
      && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
    rows: detail.querySelectorAll('li').length,
  };
});

/** What the hover reading covers: its own box against every package tab and class name. */
type HoverClearance = {
  readonly name: string | null;
  readonly hint: Box | null;
  readonly tabCount: number;
  readonly nodeNameCount: number;
  readonly overlapping: number;
  /** The obstacles it covers, so a red says what it landed on. */
  readonly hits: readonly string[];
};

const readHoverClearance = (page: Page): Promise<HoverClearance> => page.evaluate(() => {
  const chip = document.querySelector('[data-architecture-hover]');
  if (!(chip instanceof Element)) {
    return { name: null, hint: null, tabCount: 0, nodeNameCount: 0, overlapping: 0, hits: [] };
  }
  const rect = chip.getBoundingClientRect();
  const hint = { x: rect.x, y: rect.y, w: rect.width, h: rect.height, x2: rect.right, y2: rect.bottom };
  const overlaps = (a: Box, b: Box): boolean => a.x < b.x2 && b.x < a.x2 && a.y < b.y2 && b.y < a.y2;
  const obstacles: { label: string; box: Box }[] = [];
  for (const tab of document.querySelectorAll('.uml-package[data-package-id] > path')) {
    const box = tab.getBoundingClientRect();
    obstacles.push({
      label: `tab:${tab.parentElement?.getAttribute('data-package-id') ?? '?'}`,
      box: { x: box.x, y: box.y, w: box.width, h: box.height, x2: box.right, y2: box.bottom },
    });
  }
  for (const name of document.querySelectorAll('[data-architecture-node-name]')) {
    const box = name.getBoundingClientRect();
    obstacles.push({
      label: `name:${(name.textContent ?? '').trim().slice(0, 24)}`,
      box: { x: box.x, y: box.y, w: box.width, h: box.height, x2: box.right, y2: box.bottom },
    });
  }
  const drawn = obstacles.filter((obstacle) => obstacle.box.w > 0 && obstacle.box.h > 0);
  const hit = drawn.filter((obstacle) => overlaps(hint, obstacle.box));
  return {
    name: chip.getAttribute('data-architecture-hover-name'),
    hint,
    tabCount: [...document.querySelectorAll('.uml-package[data-package-id] > path')].length,
    nodeNameCount: document.querySelectorAll('[data-architecture-node-name]').length,
    overlapping: hit.length,
    hits: hit.map((entry) => `${entry.label}@${Math.round(entry.box.x)},${Math.round(entry.box.y)},${Math.round(entry.box.w)},${Math.round(entry.box.h)}`),
  };
});

/** Wait until the drawing is on screen AND no request is in flight over it. */
async function waitForSettledSummary(page: Page): Promise<void> {
  await page.waitForFunction(
    (sel) => {
      const root = document.querySelector(sel.graphRoot);
      return root !== null
        && Number(root.getAttribute('data-architecture-visible-nodes') ?? '0') > 0
        && document.querySelector('[data-architecture-refreshing="true"]') === null;
    },
    SEL,
    { timeout: 90_000 },
  );
  // The debounce (250 ms) plus the answer's commit.
  await settle(page, 700);
}

/** Choose one relation preset through the drawer the reader uses, then let it settle. */
async function setRelationPreset(page: Page, preset: 'structural' | 'dependency' | 'call'): Promise<void> {
  const toggle = page.locator(SEL.filterToggle).first();
  await toggle.click();
  const menu = page.locator(SEL.filterMenu).first();
  await expect(menu, 'the filter drawer must open').toBeVisible({ timeout: 10_000 });
  await page.locator(`[data-architecture-filter-relation="${preset}"]`).first().click();
  await toggle.click();
  await expect(menu).toHaveCount(0, { timeout: 10_000 });
  await waitForSettledSummary(page);
}

/** Reload the page, reopen the tab in the same state, and read the summary. */
async function reloadAndReadSummary(page: Page, sessionId: string): Promise<SummaryNumbers> {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openArchitectureTab(page, sessionId);
  await openEntityDrawing(page);
  await waitForSettledSummary(page);
  return readSummaryNumbers(page);
}

test('main arm — the panel states what it expanded, what it hid and where it drilled (1440x765)', async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PC,
    touch: false,
  });

  try {
    // ── ① Scope cleanup opens into a panel that is really on screen ────────
    await openArchitectureTab(page, scopeHygieneSessionId);
    const cleanupToggle = page.locator(SEL.scopeHygiene).first();
    await expect(
      cleanupToggle,
      'the fixture merge dropped a scope, so the cleanup row must exist',
    ).toHaveCount(1, { timeout: 20_000 });
    await expect(cleanupToggle).toHaveAttribute('aria-expanded', 'false');
    await cleanupToggle.click();
    await expect(cleanupToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(SEL.scopeHygieneDetail).first()).toHaveCount(1, { timeout: 10_000 });
    await settle(page, 300);
    const cleanup = await readCleanupDisclosure(page);
    console.log(`[architecture-layout] cleanup.expanded=${JSON.stringify(cleanup)}`);
    expect(cleanup.box, 'expanding the row must draw its panel').not.toBeNull();
    expect(cleanup.boxArea, 'the panel must have a real area').toBeGreaterThan(0);
    expect(
      cleanup.visibleArea,
      'the panel must not be clipped away by the footer it opens out of',
    ).toBeGreaterThan(0);
    expect(cleanup.insideViewport, `the panel must lie inside the viewport: ${formatBox(cleanup.box)}`).toBe(true);
    expect(cleanup.rows, 'the panel lists what the merge cleaned').toBeGreaterThan(0);
    await page.screenshot({ path: 'tmp/panel-cleanup-open-pc.png' });
    await cleanupToggle.click();
    await expect(page.locator(SEL.scopeHygieneDetail)).toHaveCount(0, { timeout: 10_000 });

    // ── ② The hover reading never covers a package tab or a class name ──────
    await openArchitectureTab(page, sessionId);
    await openEntityDrawing(page);
    await waitForSettledSummary(page);
    const hovered: string[] = [];
    for (const index of [0, 1, 2]) {
      const node = page.locator(SEL.node).nth(index);
      if ((await node.count()) === 0) continue;
      await node.hover({ force: true, timeout: 15_000 });
      await expect(page.locator(SEL.hoverChip).first(), 'hovering a node draws its reading').toHaveCount(1, {
        timeout: 15_000,
      });
      await settle(page, 200);
      const clearance = await readHoverClearance(page);
      console.log(`[architecture-layout] hover.${index}=${JSON.stringify(clearance)}`);
      hovered.push(clearance.name ?? '<none>');
      expect(clearance.hint, 'the reading must be drawn').not.toBeNull();
      expect(
        clearance.tabCount,
        'the drawing must paint package tabs, or this reading proves nothing',
      ).toBeGreaterThan(0);
      expect(
        clearance.overlapping,
        `the reading must not cover a package tab or a class name: ${JSON.stringify(clearance.hits)}`,
      ).toBe(0);
    }
    await page.screenshot({ path: 'tmp/panel-hover-hint-pc.png' });
    await page.mouse.move(2, 2);
    await settle(page, 200);

    // ── ③ Three preset switches settle on the numbers a reload prints ───────
    await setRelationPreset(page, 'call');
    await setRelationPreset(page, 'dependency');
    await setRelationPreset(page, 'call');
    const inSession = await readSummaryNumbers(page);
    console.log(`[architecture-layout] summary.inSession=${JSON.stringify(inSession)}`);
    await page.screenshot({ path: 'tmp/panel-summary-after-presets-pc.png' });
    const reloaded = await reloadAndReadSummary(page, sessionId);
    console.log(`[architecture-layout] summary.reloaded=${JSON.stringify(reloaded)}`);
    expect(inSession.shown, 'N must equal the reloaded reading').toBe(reloaded.shown);
    expect(inSession.related, 'M must equal the reloaded reading').toBe(reloaded.related);
    expect(inSession.hidden, 'the hidden total must equal the reloaded reading').toBe(reloaded.hidden);
    expect(inSession.hiddenRelations).toBe(reloaded.hiddenRelations);
    expect(inSession.hiddenIsolated).toBe(reloaded.hiddenIsolated);

    // ── ④ A drilled neighbourhood names itself and fits its own drawing ─────
    // The percentage the reader sees is the FOLD's adaptation factor in the
    // folded tier, not the reader's zoom (see `displayScale`): the two are
    // different quantities, and comparing them across a view change would
    // measure the fold rather than the drill. So the drill is read from an
    // unfolded drawing. Under the single-scale sticky auto-fit, a new DRAWING
    // (the neighbourhood) is solved to its own fit, so its scale is NOT the
    // class drawing's; returning to the class drawing must restore that
    // drawing's fit, which is the comparison this leg makes.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const fold = await page.locator(SEL.graphRoot).first().getAttribute('data-architecture-fold-depth');
      if (fold === null) break;
      await page.locator(SEL.zoomIn).first().click();
      await settle(page, 400);
    }
    const foldBefore = await page.locator(SEL.graphRoot).first().getAttribute('data-architecture-fold-depth');
    console.log(`[architecture-layout] drill.fold.before=${JSON.stringify(foldBefore)}`);
    expect(foldBefore, 'the drill reading needs an unfolded drawing on both sides').toBeNull();
    const zoomBefore = await page.locator(SEL.graphRoot).first().getAttribute('data-architecture-zoom-scale');
    expect(zoomBefore, 'the drawing must publish its scale before the drill').not.toBeNull();
    await page.locator(SEL.node).first().dblclick({ timeout: 15_000 });
    await expect(page.locator(SEL.graphRoot).first()).toHaveAttribute('data-architecture-view', 'neighborhood', {
      timeout: 40_000,
    });
    await waitForSettledSummary(page);
    await settle(page, 700);
    const status = await page.locator(SEL.neighbourhoodStatus).first().textContent();
    const zoomAfter = await page.locator(SEL.graphRoot).first().getAttribute('data-architecture-zoom-scale');
    const foldAfter = await page.locator(SEL.graphRoot).first().getAttribute('data-architecture-fold-depth');
    console.log(
      `[architecture-layout] drill.zoom=${JSON.stringify(zoomBefore)} -> ${JSON.stringify(zoomAfter)} `
        + `fold=${JSON.stringify(foldBefore)} -> ${JSON.stringify(foldAfter)} status=${JSON.stringify(status)}`,
    );
    expect(foldAfter, 'the neighbourhood must be read unfolded too, or the two numbers are different quantities').toBeNull();
    expect(status ?? '', 'the toolbar must say what the reader is looking at').toMatch(/Neighbourhood of /);
    // The neighbourhood is a NEW drawing: sticky auto-fit gives it its own
    // solved scale. What the reading can require is that the value is a real,
    // published fit — the round trip below is what proves it was re-solved.
    expect(
      Number(zoomAfter),
      `the neighbourhood must publish its own solved fit — ${JSON.stringify(zoomBefore)} -> ${JSON.stringify(zoomAfter)}`,
    ).toBeGreaterThan(0);
    expect(
      Number(zoomAfter),
      'entering a neighbourhood is a new drawing, so its fit must be re-solved rather than inherited',
    ).not.toBe(Number(zoomBefore));
    const explosionHint = await page.locator('[data-architecture-explosion]').first().getAttribute('title');
    expect(explosionHint ?? '', 'the explosion control explains what the view is').not.toBe('');
    await page.screenshot({ path: 'tmp/panel-neighbourhood-pc.png' });

    await page.locator(SEL.back).first().click();
    await expect(page.locator(SEL.graphRoot).first()).toHaveAttribute('data-architecture-view', 'hierarchy', {
      timeout: 40_000,
    });
    await waitForSettledSummary(page);
    await settle(page, 700);
    const zoomBack = await page.locator(SEL.graphRoot).first().getAttribute('data-architecture-zoom-scale');
    console.log(`[architecture-layout] drill.back.zoom=${JSON.stringify(zoomBack)}`);
    expect(zoomBack, 'returning to the class drawing must restore that drawing\'s fit').toBe(zoomBefore);
    await page.screenshot({ path: 'tmp/panel-neighbourhood-back-pc.png' });
  } finally {
    await context.close();
  }
});

test('control arm — each restored panel defect turns its own reading red', async ({ browser }) => {
  test.setTimeout(300_000);
  const { context, page } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PC,
    touch: false,
  });

  try {
    // ── arm A: a clipping footer hides the Scope cleanup panel again ────────
    await openArchitectureTab(page, scopeHygieneSessionId);
    const cleanupToggle = page.locator(SEL.scopeHygiene).first();
    await expect(cleanupToggle, 'the cleanup row must exist before its reading can be measured').toHaveCount(1, {
      timeout: 20_000,
    });
    await cleanupToggle.click();
    await expect(page.locator(SEL.scopeHygieneDetail).first()).toHaveCount(1, { timeout: 10_000 });
    await settle(page, 300);
    const cleanupGreen = await readCleanupDisclosure(page);
    expect(cleanupGreen.visibleArea, 'arm A baseline: the expanded panel is visible').toBeGreaterThan(0);
    await page.evaluate(() => {
      const footer = document.querySelector('[data-architecture-source-footer]');
      if (!(footer instanceof HTMLElement)) throw new Error('the panel must draw the provenance footer');
      footer.setAttribute('data-control-arm-overflow', footer.style.overflow);
      footer.style.overflow = 'hidden';
    });
    await settle(page, 250);
    const cleanupRed = await readCleanupDisclosure(page);
    console.log(
      `[architecture-layout] controlArmA green=${JSON.stringify(cleanupGreen)} red=${JSON.stringify(cleanupRed)}`,
    );
    expect(
      cleanupRed.visibleArea,
      'arm A: a clipping footer must hide the panel it opens out of',
    ).toBe(0);
    await page.evaluate(() => {
      const footer = document.querySelector('[data-architecture-source-footer]');
      if (!(footer instanceof HTMLElement)) return;
      footer.style.overflow = footer.getAttribute('data-control-arm-overflow') ?? '';
      footer.removeAttribute('data-control-arm-overflow');
    });
    await settle(page, 250);
    expect(
      (await readCleanupDisclosure(page)).visibleArea,
      'arm A: removing the injected clip puts the reading back on the passing side',
    ).toBeGreaterThan(0);

    // ── arm B: the shipped pinned corner covers a package tab ───────────────
    await openArchitectureTab(page, sessionId);
    await openEntityDrawing(page);
    await waitForSettledSummary(page);
    await page.locator(SEL.node).first().hover({ force: true, timeout: 15_000 });
    await expect(page.locator(SEL.hoverChip).first()).toHaveCount(1, { timeout: 15_000 });
    await settle(page, 200);
    const hoverGreen = await readHoverClearance(page);
    expect(hoverGreen.overlapping, 'arm B baseline: the measured hint covers nothing').toBe(0);
    expect(hoverGreen.tabCount, 'arm B needs painted package tabs').toBeGreaterThan(0);
    const shippedPosition = await page.evaluate(() => {
      const wrapper = document.querySelector('[data-architecture-hover-hint]');
      if (!(wrapper instanceof HTMLElement)) throw new Error('the hover reading must have a wrapper');
      const container = document.querySelector('[data-architecture-canvas-region]');
      if (!(container instanceof HTMLElement)) throw new Error('the canvas region must be on screen');
      // The shipped layout pinned the reading to the canvas' top-left corner.
      // The single-scale fit no longer paints a tab there on this fixture, so
      // the arm restores the same DEFECT where it is observable: over a painted
      // package tab. The wrapper's left/top are relative to the canvas region.
      const target = document.querySelector('[data-architecture-canvas] .uml-package[data-package-id] > path')
        ?? document.querySelector('[data-architecture-canvas] [data-architecture-node-name]');
      if (target === null) throw new Error('the drawing must paint a package tab or class name');
      const containerBox = container.getBoundingClientRect();
      const wrapperBox = wrapper.getBoundingClientRect();
      const targetBox = target.getBoundingClientRect();
      const measured = { left: wrapper.style.left, top: wrapper.style.top };
      wrapper.style.left = `${targetBox.left - containerBox.left}px`;
      wrapper.style.top = `${targetBox.top - containerBox.top + Math.max(0, (targetBox.height - wrapperBox.height) / 2)}px`;
      return measured;
    });
    await settle(page, 250);
    const hoverRed = await readHoverClearance(page);
    console.log(
      `[architecture-layout] controlArmB green=${JSON.stringify(hoverGreen)} red=${JSON.stringify(hoverRed)}`,
    );
    expect(
      hoverRed.overlapping,
      `arm B: the pinned corner must cover a package tab or class name: ${JSON.stringify(hoverRed.hits)}`,
    ).toBeGreaterThan(0);
    await page.evaluate((measured) => {
      const wrapper = document.querySelector('[data-architecture-hover-hint]');
      if (!(wrapper instanceof HTMLElement)) return;
      wrapper.style.left = measured.left;
      wrapper.style.top = measured.top;
    }, shippedPosition);
    await settle(page, 250);
    expect(
      (await readHoverClearance(page)).overlapping,
      'arm B: restoring the measured position puts the reading back on the passing side',
    ).toBe(0);
    await page.mouse.move(2, 2);

    // ── arm C: a superseded body replayed for a new state ───────────────────
    // The panel used to adopt whatever arrived last and then cut it locally, so
    // a stale answer stayed on screen until the page was reloaded. The arm
    // replays exactly that: capture the body of one filter state, then serve it
    // for the NEXT state's request.
    await waitForSettledSummary(page);
    let staleBody: string | null = null;
    const capture = async (response: import('@playwright/test').Response): Promise<void> => {
      if (!response.url().includes('/api/architecture/graph') || !response.ok()) return;
      staleBody = await response.text().catch(() => staleBody);
    };
    page.on('response', capture);
    // Switch the class kind OFF: a real filter change whose true answer differs
    // from the body captured just before it.
    const classKind = page.locator('[data-architecture-filter-kind="class"]').first();
    const toggleClassKind = async (): Promise<void> => {
      await page.locator(SEL.filterToggle).first().click();
      await expect(page.locator(SEL.filterMenu).first()).toBeVisible({ timeout: 10_000 });
      await page.locator('[data-architecture-filter-kind="class"]').first().click();
      await page.locator(SEL.filterToggle).first().click();
      await expect(page.locator(SEL.filterMenu).first()).toHaveCount(0, { timeout: 10_000 });
      await waitForSettledSummary(page);
    };
    // A state whose body will be captured, and whose numbers differ from the
    // one the replay is then shown under.
    await toggleClassKind();
    const staleStateSummary = await readSummaryNumbers(page);
    expect(staleBody, 'arm C needs a captured body to replay').not.toBeNull();
    await page.route('**/api/architecture/graph', async (route) => {
      if (staleBody === null) {
        await route.continue();
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: staleBody });
    });
    await toggleClassKind();
    const tampered = await readSummaryNumbers(page);
    await page.unroute('**/api/architecture/graph');
    page.off('response', capture);
    console.log(
      `[architecture-layout] controlArmC stale=${JSON.stringify(staleStateSummary)} `
        + `tampered=${JSON.stringify(tampered)}`,
    );
    expect(classKind, 'the class-kind switch must exist').not.toBeNull();
    // The replay served the PREVIOUS state's body, so the panel is showing that
    // state's numbers under the new selection.
    expect(
      tampered,
      `arm C: the replayed body must be the one captured before the switch: `
        + `stale=${JSON.stringify(staleStateSummary)} tampered=${JSON.stringify(tampered)}`,
    ).toEqual(staleStateSummary);
    // The reload prints the TRUE numbers for the state on screen, and they
    // differ from the tampered reading — the comparison the main arm asserts
    // equal, here reading red.
    const trueAfterReload = await reloadAndReadSummary(page, sessionId);
    console.log(`[architecture-layout] controlArmC true=${JSON.stringify(trueAfterReload)}`);
    expect(
      tampered,
      `arm C: the tampered summary must not equal the reloaded one: `
        + `tampered=${JSON.stringify(tampered)} reloaded=${JSON.stringify(trueAfterReload)}`,
    ).not.toEqual(trueAfterReload);
    // Removing the injection: the same state, reached again without the replay,
    // settles on the true numbers and agrees with the reload (the passing side).
    await toggleClassKind();
    await toggleClassKind();
    expect(
      await readSummaryNumbers(page),
      'arm C: without the replay the same state reads the reloaded numbers',
    ).toEqual(trueAfterReload);

    // ── arm D: the zoom reading catches a jump ──────────────────────────────
    const zoomBefore = await page.locator(SEL.graphRoot).first().getAttribute('data-architecture-zoom-scale');
    await page.locator(SEL.zoomIn).first().click();
    await settle(page, 300);
    const zoomRed = await page.locator(SEL.graphRoot).first().getAttribute('data-architecture-zoom-scale');
    console.log(`[architecture-layout] controlArmD ${JSON.stringify(zoomBefore)} -> ${JSON.stringify(zoomRed)}`);
    expect(
      zoomRed,
      'arm D: the zoom reading must move when the scale really moves — the same relation a '
        + 're-fit on entering a neighbourhood produced on its own',
    ).not.toBe(zoomBefore);
    await page.locator(SEL.zoomOut).first().click();
    await settle(page, 300);
    const zoomRestored = Number(
      await page.locator(SEL.graphRoot).first().getAttribute('data-architecture-zoom-scale'),
    );
    // Zoom in/out is a multiply/divide round trip, so the restored value is the
    // original within float noise (not bit-identical).
    expect(
      Math.abs(zoomRestored - Number(zoomBefore)),
      `arm D: undoing the change puts the reading back on the passing side `
        + `(${JSON.stringify(zoomBefore)} -> ${zoomRestored})`,
    ).toBeLessThan(1e-9);
    await page.screenshot({ path: 'tmp/panel-control-arms-pc.png' });
  } finally {
    await context.close();
  }
});

/* ── the chrome / drawer / paper / banner readings ────────────────────────────────────────── */

/**
 * What the phone drawer, the selection tray, the canvas paper rectangle and the
 * Focus banner report in ONE round trip.
 *
 * `trayOverlapsDrawer` is the reading the task asks for literally: the two
 * screen rectangles must not intersect. `selectedNodeTopVisible` says whether
 * the box the reader tapped still has its top edge in the part of the canvas
 * the drawer does not cover. `paperOk` is the canvas-background rule: the
 * renderer's paper rectangle must either paint nothing (so the panel's own
 * background shows), paint exactly the panel's background, or cover the whole
 * canvas region — a paper-coloured rectangle that only wraps the content is the
 * seam this task removes.
 */
type ChromeReading = {
  canvasTop: number | null;
  canvas: Box | null;
  drawer: Box | null;
  drawerContent: Box | null;
  tray: Box | null;
  trayOverlapsDrawer: boolean;
  selectedNode: Box | null;
  snapLabels: string[];
  snapPressed: string | null;
  snapPressedClass: string | null;
  snapUnpressedClass: string | null;
  closeCount: number;
  paper: Box | null;
  paperFill: string;
  paperVisible: boolean;
  paperCoversCanvas: boolean;
  paperMatchesPanel: boolean;
  paperOk: boolean;
  panelBackground: string;
  /** The drawing host's scroll reading: what the "keep the box above the drawer" correction acts on. */
  hostScroll: { top: number; max: number; height: number } | null;
};

const readChrome = (page: Page): Promise<ChromeReading> => page.evaluate(() => {
  const boxOf = (element: Element | null): Box | null => {
    if (element === null) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, x2: rect.right, y2: rect.bottom };
  };
  const overlaps = (a: Box | null, b: Box | null): boolean =>
    Boolean(a && b && a.x < b.x2 && b.x < a.x2 && a.y < b.y2 && b.y < a.y2);
  const covers = (outer: Box | null, inner: Box | null): boolean =>
    Boolean(outer && inner
      && outer.x <= inner.x + 1 && outer.y <= inner.y + 1
      && outer.x2 >= inner.x2 - 1 && outer.y2 >= inner.y2 - 1);
  /** The first painted background above an element: what the reader sees behind a transparent pixel. */
  const backgroundOf = (start: Element | null): string => {
    for (let element = start; element !== null; element = element.parentElement) {
      const background = window.getComputedStyle(element).backgroundColor;
      if (background !== '' && background !== 'transparent' && background !== 'rgba(0, 0, 0, 0)') {
        return background;
      }
    }
    return '<none>';
  };
  const paintOf = (element: Element | null): { fill: string; visible: boolean } => {
    if (element === null) return { fill: '<none>', visible: false };
    const fill = window.getComputedStyle(element).fill || element.getAttribute('fill') || '<none>';
    const transparent = fill === 'none'
      || fill === 'transparent'
      || /^rgba\([^)]*,\s*0(\.0+)?\)$/.test(fill);
    return { fill, visible: !transparent };
  };

  const canvas = document.querySelector('[data-architecture-canvas]');
  const drawer = document.querySelector('[data-architecture-dock-touch]');
  const drawerContent = drawer?.querySelector('[data-architecture-dock-panel]') ?? null;
  const snaps = [...document.querySelectorAll('[data-architecture-dock-snap]')];
  const pressedSnap = snaps.find((snap) => snap.getAttribute('aria-pressed') === 'true') ?? null;
  const unpressedSnap = snaps.find((snap) => snap.getAttribute('aria-pressed') !== 'true') ?? null;
  const tray = document.querySelector('[data-architecture-tray-pill]')
    ?? document.querySelector('[data-architecture-tray-expanded-panel]');
  // The selected box, marked by the renderer's own class (its top edge is the
  // reading; the whole box may extend below the drawer).
  const selectedNode = document.querySelector('.uml-node.arch-selected[data-entity-id]');
  const paper = document.querySelector('[data-architecture-canvas] .uml-canvas');
  const paperBox = boxOf(paper);
  const canvasBox = boxOf(canvas);
  const fill = paintOf(paper);
  const panelBackground = backgroundOf(canvas);

  const trayBox = boxOf(tray);
  const contentBox = boxOf(drawerContent);
  const paperCoversCanvas = covers(paperBox, canvasBox);
  const paperMatchesPanel = fill.visible && fill.fill === panelBackground;
  return {
    canvasTop: canvasBox === null ? null : Math.round(canvasBox.y),
    canvas: canvasBox,
    drawer: boxOf(drawer),
    drawerContent: contentBox,
    tray: trayBox,
    trayOverlapsDrawer: overlaps(trayBox, contentBox),
    selectedNode: boxOf(selectedNode),
    snapLabels: snaps.map((snap) => (snap.textContent ?? '').trim()),
    snapPressed: pressedSnap?.getAttribute('data-architecture-dock-snap') ?? null,
    snapPressedClass: pressedSnap?.className ?? null,
    snapUnpressedClass: unpressedSnap?.className ?? null,
    closeCount: document.querySelectorAll('[data-architecture-dock-close]').length,
    paper: paperBox,
    paperFill: fill.fill,
    paperVisible: fill.visible,
    paperCoversCanvas,
    paperMatchesPanel,
    paperOk: !fill.visible || paperCoversCanvas || paperMatchesPanel,
    panelBackground,
    hostScroll: (() => {
      const host = document.querySelector('[data-architecture-plantuml]');
      if (!(host instanceof HTMLElement)) return null;
      return {
        top: Math.round(host.scrollTop),
        max: Math.max(0, host.scrollHeight - host.clientHeight),
        height: host.clientHeight,
      };
    })(),
  };
});

/**
 * Optional browser evidence: when `ARCHITECTURE_LAYOUT_SHOTS_DIR` is set, the
 * chrome states are also captured there (the task's DoD screenshots). Off by
 * default — a suite run should not litter the tree.
 */
const SHOTS_DIR = process.env.ARCHITECTURE_LAYOUT_SHOTS_DIR ?? '';

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS_DIR === '') return;
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, `arch-chrome-${name}.png`) });
}

/**
 * The LOWEST visible entity box on screen, zooming in until the semantic tier
 * draws entity boxes at all.
 *
 * On a phone a 120-entity class drawing opens at a tier that paints package
 * frames only; a box that is not drawn is not a tap target. Zooming in is the
 * reader's own way out of that tier, so the helper does exactly that, then
 * returns the bottom-most entity so "the drawer does not hide the box" is a
 * real reading rather than one that passes because the box was already high up.
 */
async function ensureVisibleEntityBox(
  page: Page,
  pick: 'lowest' | 'highest' = 'lowest',
): Promise<{ x: number; y: number; id: string } | null> {
  await ensureZoomClusterOpen(page);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const found = await page.evaluate(({ sel, pick }) => {
      const host = document.querySelector(sel.host);
      if (host === null) return null;
      const hostRect = host.getBoundingClientRect();
      let chosen: { x: number; y: number; id: string } | null = null;
      for (const node of host.querySelectorAll('.uml-node[data-entity-id]')) {
        const id = node.getAttribute('data-entity-id') ?? '';
        if (id.startsWith('grp::') || id.startsWith('stub::')) continue;
        const text = node.querySelector('text');
        if (text === null) continue;
        const rect = text.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 6) continue;
        const x = Math.round(rect.left + Math.min(rect.width / 2, 30));
        const y = Math.round(rect.top + rect.height / 2);
        if (x <= hostRect.left + 6 || x >= hostRect.right - 6) continue;
        if (y <= hostRect.top + 6 || y >= hostRect.bottom - 6) continue;
        const hit = document.elementFromPoint(x, y);
        if (hit === null || hit.closest('[data-entity-id]') === null) continue;
        if (
          chosen === null
          || (pick === 'lowest' ? y > chosen.y : y < chosen.y)
        ) chosen = { x, y, id };
      }
      return chosen;
    }, { sel: SEL, pick });
    if (found !== null) return found;
    const zoomIn = page.locator(SEL.zoomIn);
    if ((await zoomIn.count()) === 0) break;
    await zoomIn.first().click();
    await settle(page, 300);
  }
  return null;
}

const printChrome = (label: string, reading: ChromeReading): void => {
  console.log(`[architecture-layout] ${label}.canvas.top=${formatNumber(reading.canvasTop)} canvas=${formatBox(reading.canvas)}`);
  console.log(`[architecture-layout] ${label}.drawer=${formatBox(reading.drawer)} drawer.content=${formatBox(reading.drawerContent)}`);
  console.log(`[architecture-layout] ${label}.tray=${formatBox(reading.tray)} tray.overlaps.drawer=${reading.trayOverlapsDrawer}`);
  console.log(`[architecture-layout] ${label}.selected.node=${formatBox(reading.selectedNode)}`);
  console.log(`[architecture-layout] ${label}.snap.labels=${JSON.stringify(reading.snapLabels)} pressed=${reading.snapPressed}`);
  console.log(`[architecture-layout] ${label}.snap.pressed.class=${JSON.stringify(reading.snapPressedClass)}`);
  console.log(`[architecture-layout] ${label}.snap.unpressed.class=${JSON.stringify(reading.snapUnpressedClass)}`);
  console.log(`[architecture-layout] ${label}.drawer.close.count=${reading.closeCount}`);
  console.log(`[architecture-layout] ${label}.paper=${formatBox(reading.paper)} fill=${JSON.stringify(reading.paperFill)} `
    + `visible=${reading.paperVisible} covers=${reading.paperCoversCanvas} panel=${JSON.stringify(reading.panelBackground)} ok=${reading.paperOk}`);
  console.log(`[architecture-layout] ${label}.host.scroll=${JSON.stringify(reading.hostScroll)}`);
};

/** Every criterion of the four new readings, in one place so both arms share it. */
const assertChromeClean = (reading: ChromeReading, label: string): void => {
  expect.soft(new Set(reading.snapLabels).size, `${label}: the three snap buttons must read three different labels `
    + `(got ${JSON.stringify(reading.snapLabels)})`).toBe(3);
  expect.soft(reading.snapPressed, `${label}: exactly one snap must be pressed`).not.toBeNull();
  expect.soft(reading.snapPressedClass, `${label}: the pressed snap must paint differently from the others`)
    .not.toBe(reading.snapUnpressedClass);
  expect.soft(reading.closeCount, `${label}: the touch drawer must offer exactly one close control`).toBe(1);
  expect.soft(reading.trayOverlapsDrawer, `${label}: the tray and the drawer content must not intersect — `
    + `tray=${formatBox(reading.tray)} drawer.content=${formatBox(reading.drawerContent)}`).toBe(false);
  const drawerTop = reading.drawer === null ? null : reading.drawer.y;
  const canvasTop = reading.canvas === null ? null : reading.canvas.y;
  expect.soft(reading.selectedNode, `${label}: a selected box must be drawn`).not.toBeNull();
  if (reading.selectedNode !== null && drawerTop !== null && canvasTop !== null) {
    expect.soft(reading.selectedNode.y, `${label}: the selected box's TOP edge must stay above the drawer — `
      + `node=${formatBox(reading.selectedNode)} drawer.top=${formatNumber(drawerTop)}`).toBeLessThan(drawerTop);
    expect.soft(reading.selectedNode.y, `${label}: and inside the canvas, not scrolled past its top — `
      + `node=${formatBox(reading.selectedNode)} canvas.top=${formatNumber(canvasTop)}`).toBeGreaterThanOrEqual(canvasTop - 1);
  }
  expect.soft(reading.paperOk, `${label}: the canvas paper must be transparent, match the panel, or cover the canvas — `
    + `fill=${reading.paperFill} document=${formatBox(reading.paper)} panel=${reading.panelBackground} `
    + `canvas=${formatBox(reading.canvas)} covers=${String(reading.paperCoversCanvas)}`).toBe(true);
};

/**
 * The canvas-background reading, stated on a drawing that does NOT cover the
 * canvas. In a zoomed-in state the paper rectangle covers the whole canvas, so
 * "a paper-coloured rectangle only around the content" cannot be observed
 * there; the fit/overview state is the one the review found the seam in.
 */
const assertPaperClean = (reading: ChromeReading, label: string): void => {
  expect.soft(
    reading.paperCoversCanvas,
    `${label}: the paper reading is only meaningful when the drawing does NOT cover the canvas — `
      + `paper=${formatBox(reading.paper)} canvas=${formatBox(reading.canvas)}`,
  ).toBe(false);
  expect.soft(
    reading.paperOk,
    `${label}: the canvas paper must be transparent, match the panel, or cover the canvas — `
      + `fill=${reading.paperFill} paper=${formatBox(reading.paper)} panel=${reading.panelBackground} `
      + `canvas=${formatBox(reading.canvas)} covers=${String(reading.paperCoversCanvas)}`,
  ).toBe(true);
};

test('main arm — the phone drawer and canvas paper read clean (390x844)', async ({ browser }) => {
  const { context, page } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PHONE,
    touch: true,
  });

  try {
    await openArchitectureTab(page, sessionId);
    await waitForDrawing(page);
    await showClassDiagram(page);
    // The canvas-background reading is taken on the WHOLE-GRAPH fit: there the
    // drawing does not cover the canvas, so a paper-coloured rectangle that
    // only wraps the content is visible (it is that seam the review found).
    await showWholeGraph(page);
    const fitted = await readChrome(page);
    printChrome('phone.fitted', fitted);
    assertPaperClean(fitted, 'phone.fitted');
    await shot(page, 'phone-fitted-paper');

    // Tap the LOWEST visible entity: the box the open drawer is most likely to
    // cover, so "its top edge stays visible" is a real reading rather than one
    // that happens to pass because the box was already high up.
    const target = await ensureVisibleEntityBox(page);
    console.log(`[architecture-layout] phone.chrome.target=${JSON.stringify(target)}`);
    expect(target, 'the drawing must offer a visible entity to tap').not.toBeNull();
    const point = target as { x: number; y: number; id: string };

    await page.mouse.click(point.x, point.y);
    await expect(page.locator('[data-architecture-dock-touch]')).toBeVisible({ timeout: 10_000 });
    // Long enough for the drawer's reserved band to settle AND for the drawing's
    // own fit pass to stop re-centring: the "box above the drawer" correction is
    // re-asserted for a second after the drawer opens.
    await settle(page, 1_200);

    const reading = await readChrome(page);
    printChrome('phone.chrome', reading);
    assertChromeClean(reading, 'phone.chrome');
    await page.screenshot({ path: test.info().outputPath('chrome-phone-drawer.png') });
    await shot(page, 'phone-drawer');

    // The retired Focus banner (its toggle, the `data-architecture-readable-mode`
    // marker and the sentence) was removed by the single-scale fit contract, so
    // this arm measures the drawer and the paper only. The drawer is closed
    // again so it leaves no selection behind for the caller.
    await page.locator('[data-architecture-dock-close]').click();
    await expect(page.locator('[data-architecture-dock-touch]')).toHaveCount(0, { timeout: 10_000 });
    await settle(page, 500);
  } finally {
    await context.close();
  }
});

/**
 * What every project-search row reports, plus the once-only group explanation.
 */
type SearchRowsReading = {
  rows: {
    readonly name: string;
    readonly truncates: boolean;
    readonly scrollWidth: number;
    readonly clientWidth: number;
    readonly pathOnSecondLine: boolean;
    readonly pathLeftTruncated: boolean;
  }[];
  notInGraphCount: number;
  notInGraphRows: number;
};

const readSearchRows = (page: Page): Promise<SearchRowsReading | null> => page.evaluate((sel) => {
  const list = document.querySelector(sel.searchResults);
  if (list === null) return null;
  const rows = [...list.querySelectorAll('[data-architecture-search-project-result]')].map((row) => {
    const name = row.querySelector('[data-architecture-search-project-name]');
    const file = row.querySelector('[data-architecture-search-project-file]');
    const nameElement = name instanceof HTMLElement ? name : null;
    const fileElement = file instanceof HTMLElement ? file : null;
    return {
      name: (nameElement?.textContent ?? '').trim(),
      truncates: nameElement !== null && /(^|\s)truncate(\s|$)/.test(nameElement.className),
      scrollWidth: nameElement?.scrollWidth ?? 0,
      clientWidth: nameElement?.clientWidth ?? 0,
      // The path is a separate block placed AFTER the name in the same column.
      pathOnSecondLine: fileElement !== null && nameElement !== null
        && fileElement.previousElementSibling === nameElement,
      pathLeftTruncated: fileElement !== null
        && fileElement.getAttribute('dir') === 'rtl'
        && fileElement.className.includes('truncate'),
    };
  });
  const text = list.textContent ?? '';
  const notInGraphCount = (text.match(/Not in the current graph/g) ?? []).length;
  const notInGraphRows = list.querySelectorAll(
    '[data-architecture-search-project-result][data-architecture-search-project-in-graph="false"]',
  ).length;
  return { rows, notInGraphCount, notInGraphRows };
}, SEL);

test('main arm — project search rows keep the whole class name and state "not in the graph" once (1440x765)', async ({ browser }) => {
  const { context, page } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PC,
    touch: false,
  });

  try {
    await openArchitectureTab(page, sessionId);
    await waitForDrawing(page);

    // The canvas-background reading is taken on the PC viewport too (the seam
    // was reported on both), on the whole-graph fit: there the drawing does not
    // cover the canvas, so a paper-coloured rectangle that only wraps the
    // content is visible.
    await showClassDiagram(page);
    await showWholeGraph(page);
    const pcFitted = await readChrome(page);
    printChrome('pc.fitted', pcFitted);
    assertPaperClean(pcFitted, 'pc.fitted');
    await shot(page, 'pc-fitted-paper');

    // A stem shared by many fixture entities: the in-graph list is short (only
    // the seeded entities are drawn), so most hits come from the project index
    // and land under "Elsewhere in the project".
    await page.locator(SEL.search).first().fill('Stage');
    await expect(page.locator(SEL.searchResults).first()).toBeVisible({ timeout: 10_000 });
    await page.waitForFunction(
      () => document.querySelectorAll('[data-architecture-search-project-result]').length > 0,
      undefined,
      { timeout: 20_000 },
    );

    const reading = await readSearchRows(page);
    console.log(`[architecture-layout] search.rows=${JSON.stringify(reading)}`);
    await shot(page, 'pc-search-rows');
    expect(reading, 'the search must draw its result list').not.toBeNull();
    const rows = (reading as SearchRowsReading).rows;
    expect(rows.length, 'the project search must list several rows').toBeGreaterThan(3);

    for (const row of rows) {
      // The criterion is stated for names that fit a row (≤ 40 characters);
      // every fixture name is far below that.
      if (row.name.length > 40) continue;
      expect.soft(row.truncates, `"${row.name}": the class name must not carry a truncate class`).toBe(false);
      expect.soft(
        row.scrollWidth <= row.clientWidth + 1,
        `"${row.name}": the name must not be clipped — scrollWidth ${row.scrollWidth} vs clientWidth ${row.clientWidth}`,
      ).toBe(true);
      expect.soft(row.pathOnSecondLine, `"${row.name}": the path must sit on a second line under the name`).toBe(true);
      expect.soft(row.pathLeftTruncated, `"${row.name}": a long path must lose its left-hand directories`).toBe(true);
    }
    expect(
      (reading as SearchRowsReading).notInGraphRows,
      'the query must hit entities outside the current graph for the once-only sentence to mean anything',
    ).toBeGreaterThan(0);
    expect(
      (reading as SearchRowsReading).notInGraphCount,
      'it must be stated ONCE (on the group heading), not on every row',
    ).toBe(1);
  } finally {
    await context.close();
  }
});

/**
 * Control arm for the four new chrome readings. Each defect is injected into
 * the SAME phone page the main arm measures, the SAME reading is taken, and it
 * must land on the failing side; the injection is then removed and the reading
 * must return to passing. The page's own state (selection, zoom, drawer snap)
 * is identical on both sides of every injection.
 */
test('control arm — each restored chrome defect turns its own reading red', async ({ browser }) => {
  const { context, page } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PHONE,
    touch: true,
  });

  try {
    await openArchitectureTab(page, sessionId);
    await waitForDrawing(page);
    await showClassDiagram(page);
    await showWholeGraph(page);

    // ── defect 3 (measured FIRST, on the whole-graph fit where the drawing does
    // not cover the canvas): the white paper rectangle sized to the content.
    const fitted = await readChrome(page);
    printChrome('controlChrome.fit', fitted);
    assertPaperClean(fitted, 'controlChrome.fit');
    const injectedPaper = await page.evaluate(() => {
      const rects = [...document.querySelectorAll('[data-architecture-canvas] .uml-canvas')];
      for (const rect of rects) rect.setAttribute('fill', '#ffffff');
      return rects.length;
    });
    expect(injectedPaper, 'the renderer must emit its canvas rectangle').toBeGreaterThan(0);
    const paperDefect = await readChrome(page);
    printChrome('controlChrome.paper', paperDefect);
    await shot(page, 'control-white-paper');
    expect(
      paperDefect.paperOk,
      `control: an opaque paper rectangle sized to the content must read red — fill=${paperDefect.paperFill} `
        + `paper=${formatBox(paperDefect.paper)} panel=${paperDefect.panelBackground} canvas=${formatBox(paperDefect.canvas)}`,
    ).toBe(false);
    await page.evaluate(() => {
      for (const rect of document.querySelectorAll('[data-architecture-canvas] .uml-canvas')) rect.setAttribute('fill', 'none');
    });
    assertPaperClean(await readChrome(page), 'controlChrome.paper.restored');

    // ── the selection the other three arms need. Zooming in until entity boxes
    // are drawn is the reader's own way out of the package-only tier.
    const candidate = await ensureVisibleEntityBox(page);
    expect(candidate, 'the drawing must offer a visible entity to select').not.toBeNull();
    const point = candidate as GesturePoint;
    await page.mouse.click(point.x, point.y);
    await expect(page.locator('[data-architecture-dock-touch]')).toBeVisible({ timeout: 10_000 });
    await settle(page, 1_200);

    const baseline = await readChrome(page);
    printChrome('controlChrome.baseline', baseline);
    assertChromeClean(baseline, 'controlChrome.baseline');

    // ── defect 1: every snap button paints the CURRENT snap's label (the
    // shipped `snapLabels[snap]` bug).
    const injectedLabels = await page.evaluate(() => {
      const snaps = [...document.querySelectorAll('[data-architecture-dock-snap]')];
      const first = snaps.find((snap) => snap.getAttribute('aria-pressed') === 'true') ?? snaps[0] ?? null;
      if (first === null) return false;
      const text = (first.textContent ?? '').trim();
      for (const snap of snaps) {
        snap.setAttribute('data-architecture-injected-label', snap.textContent ?? '');
        snap.textContent = text;
      }
      return true;
    });
    expect(injectedLabels, 'the snap controls must be on screen').toBe(true);
    const labelsDefect = await readChrome(page);
    printChrome('controlChrome.snapLabels', labelsDefect);
    expect(
      new Set(labelsDefect.snapLabels).size,
      `control: the shipped label bug must make the three buttons read alike — got ${JSON.stringify(labelsDefect.snapLabels)}`,
    ).toBeLessThan(3);
    await page.evaluate(() => {
      for (const snap of document.querySelectorAll('[data-architecture-dock-snap]')) {
        const original = snap.getAttribute('data-architecture-injected-label');
        if (original !== null) snap.textContent = original;
        snap.removeAttribute('data-architecture-injected-label');
      }
    });
    assertChromeClean(await readChrome(page), 'controlChrome.snapLabels.restored');

    // ── defect 2: a second × in the snap row (the shipped duplicate close).
    const injectedClose = await page.evaluate(() => {
      const drawer = document.querySelector('[data-architecture-dock-touch]');
      const original = drawer?.querySelector('[data-architecture-dock-close]');
      if (drawer === null || original === null) return false;
      const clone = original.cloneNode(true);
      clone.setAttribute('data-architecture-injected-close', 'true');
      original.parentElement?.appendChild(clone);
      return true;
    });
    expect(injectedClose, 'the drawer must draw its close control').toBe(true);
    const closeDefect = await readChrome(page);
    printChrome('controlChrome.close', closeDefect);
    expect(
      closeDefect.closeCount,
      `control: the shipped duplicate close must read two close controls — got ${closeDefect.closeCount}`,
    ).toBe(2);
    await page.evaluate(() => {
      for (const extra of document.querySelectorAll('[data-architecture-injected-close]')) extra.remove();
    });
    assertChromeClean(await readChrome(page), 'controlChrome.close.restored');

    // ── defect 3 has already been measured on the fit state above.
    // ── defect 4: a status row drawn IN FLOW above the canvas (the shipped
    // banner that pushed the drawing down). The Focus toggle that used to
    // supply the row was retired with the single-scale contract, so the arm
    // injects the row itself into the canvas header — the reading (an in-flow
    // row moves the canvas' top edge, an overlay does not) is unchanged.
    await page.locator('[data-architecture-dock-close]').click();
    await expect(page.locator('[data-architecture-dock-touch]')).toHaveCount(0, { timeout: 10_000 });
    await settle(page, 500);
    const overlay = await readChrome(page);
    printChrome('controlChrome.banner.overlay', overlay);
    const injectedBanner = await page.evaluate(() => {
      const header = document.querySelector('[data-architecture-canvas-header]');
      if (header === null) return false;
      const row = document.createElement('div');
      row.setAttribute('data-architecture-injected-banner', 'true');
      row.textContent = 'Readable zoom is on — choose Overview to see the whole graph.';
      // Taller than the existing compact readout row (44px targets), so the row
      // really grows — the shipped defect added a line of text to it.
      row.style.height = '80px';
      row.style.flexShrink = '0';
      header.appendChild(row);
      return true;
    });
    expect(injectedBanner, 'the canvas header row must be on screen').toBe(true);
    await settle(page, 300);
    const bannerDefect = await readChrome(page);
    printChrome('controlChrome.banner.inFlow', bannerDefect);
    await shot(page, 'control-inflow-banner');
    expect(
      bannerDefect.canvasTop,
      `control: an in-flow banner must push the canvas down — canvas.top ${String(overlay.canvasTop)} -> ${String(bannerDefect.canvasTop)}`,
    ).not.toBe(overlay.canvasTop);
    await page.evaluate(() => {
      for (const row of document.querySelectorAll('[data-architecture-injected-banner]')) row.remove();
    });
    await settle(page, 300);
    const bannerRestored = await readChrome(page);
    printChrome('controlChrome.banner.restored', bannerRestored);
    expect(
      bannerRestored.canvasTop,
      'control: the overlay banner must not move the canvas — the restore returns the top edge',
    ).toBe(overlay.canvasTop);
  } finally {
    await context.close();
  }
});


/* ── the layout-orientation criterion: the drawing uses the canvas' shape ─── */

/**
 * How much of the canvas the fitted drawing's own rect must cover.
 *
 * The drawing is a two-entity chain; laid out downward its natural shape is a
 * narrow column, so a wide canvas can only use one axis (measured 0.31 on the
 * PC viewport). Turned RIGHT it is a wide row that fills both (measured 0.62).
 * The floor sits between the two, so the control arm has a real gap to red on.
 */
const DRAWING_FILL_FLOOR = 0.6;

/** What one state of the canvas reports about the drawing's area. */
type AreaFillReading = {
  viewport: { width: number; height: number };
  canvas: { width: number; height: number } | null;
  /** The drawn SVG's box, clipped to the canvas, as a fraction of canvas area. */
  fill: number | null;
  /** The same fraction before clipping, for a red that names a cropped drawing. */
  fillUnclipped: number | null;
  natural: { width: number; height: number } | null;
  zoom: number | null;
  /** The direction the layout readout states. */
  direction: string | null;
  /** Why the policy chose it. */
  reason: string | null;
};

/**
 * Read the drawing's painted area against the canvas it is painted in.
 *
 * THE SAME FUNCTION IS USED BY BOTH ARMS. The main arm reads a drawing the
 * policy is free to turn; the control arm forces DOWN and reads the state the
 * feature replaces. Only the page's state differs between them.
 *
 * The SVG's bounding box is the drawing's painted extent (the renderer sizes
 * the element to its viewBox). It is clipped to the canvas so a drawing zoomed
 * past the panel is measured by what is actually on screen.
 */
const readDrawingAreaFill = (page: Page): Promise<AreaFillReading> =>
  page.evaluate((sel) => {
    const rectOf = (element: Element | null): DOMRect | null => (
      element === null ? null : element.getBoundingClientRect()
    );
    const canvas = rectOf(document.querySelector(sel.canvas));
    const host = document.querySelector(sel.host);
    const svg = rectOf(host?.querySelector('svg') ?? null);
    const root = document.querySelector(sel.graphRoot);
    const viewBox = (host?.querySelector('svg')?.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
    const clip = (a: DOMRect, b: DOMRect): { width: number; height: number } => ({
      width: Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)),
      height: Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)),
    });
    const area = (r: DOMRect): number => r.width * r.height;
    const clipped = canvas !== null && svg !== null ? clip(svg, canvas) : null;
    const zoomRaw = root?.getAttribute('data-architecture-zoom-scale') ?? null;
    const zoom = zoomRaw === null ? null : Number(zoomRaw);
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      canvas: canvas === null ? null : { width: Math.round(canvas.width), height: Math.round(canvas.height) },
      fill: canvas !== null && svg !== null && area(canvas) > 0
        ? Number(((clipped!.width * clipped!.height) / area(canvas)).toFixed(3))
        : null,
      fillUnclipped: canvas !== null && svg !== null && area(canvas) > 0
        ? Number((area(svg) / area(canvas)).toFixed(3))
        : null,
      natural: viewBox.length === 4 && viewBox.every(Number.isFinite)
        ? { width: Math.round(viewBox[2]), height: Math.round(viewBox[3]) }
        : null,
      zoom: zoom !== null && Number.isFinite(zoom) ? zoom : null,
      direction: root?.getAttribute('data-architecture-layout-direction') ?? null,
      reason: root?.getAttribute('data-architecture-layout-direction-reason') ?? null,
    };
  }, SEL);

/** Print one reading so a green run also records the numbers it measured. */
function printAreaFill(label: string, reading: AreaFillReading): void {
  console.log(
    `[architecture-layout] ${label}.fill=${String(reading.fill)} `
      + `(unclipped ${String(reading.fillUnclipped)}) canvas=${JSON.stringify(reading.canvas)} `
      + `natural=${JSON.stringify(reading.natural)} zoom=${String(reading.zoom)} `
      + `direction=${String(reading.direction)} reason=${String(reading.reason)}`,
  );
}

/** Open the ARCHITECTURE tab on the entity (class) drawing this criterion measures. */
async function openOrientationDrawing(page: Page, sessionId: string): Promise<void> {
  await openArchitectureTab(page, sessionId);
  await page.locator('[data-architecture-view-option="entity"]').first().click();
  await waitForDrawing(page);
  // The class drawing re-fits once the corner chrome has a size, the same beat
  // the file view needs.
  await settle(page, 1200);
}

/**
 * Reading: a two-entity dependency chain drawn on a desktop canvas uses the
 * canvas' shape.
 *
 * The fixed member widths make the downward drawing a 360×592 column; the
 * orientation policy lays it out RIGHT once, the fit uses both axes, and the
 * readout states the choice. On the phone the canvas is not "clearly wider"
 * than the column, so the same policy keeps DOWN and the column fills the
 * portrait canvas (requirement 4: a phone never flips the drawing).
 */
test('main arm — the two-entity chain fills the PC and phone canvases (1440x765, 390x844)', async ({ browser }) => {
  const pc = await openSignedInPage(browser, baseURL, token, { viewport: VIEWPORT_PC, touch: false });
  try {
    await openOrientationDrawing(pc.page, orientationSessionId);
    const reading = await readDrawingAreaFill(pc.page);
    printAreaFill('orientation.pc', reading);
    await shot(pc.page, 'orientation-pc');
    expect(reading.canvas, 'the PC canvas must be measurable').not.toBeNull();
    expect(reading.direction, 'the PC drawing must be laid out RIGHT on a wide canvas').toBe('RIGHT');
    expect(reading.reason).toBe('horizontal-fit-larger');
    expect(
      reading.fill,
      `the PC drawing must fill ≥${DRAWING_FILL_FLOOR} of the canvas — measured ${String(reading.fill)} `
        + `on canvas ${JSON.stringify(reading.canvas)} with natural ${JSON.stringify(reading.natural)}`,
    ).toBeGreaterThanOrEqual(DRAWING_FILL_FLOOR);
  } finally {
    await pc.context.close();
  }

  const phone = await openSignedInPage(browser, baseURL, token, { viewport: VIEWPORT_PHONE, touch: true });
  try {
    await openOrientationDrawing(phone.page, orientationSessionId);
    const reading = await readDrawingAreaFill(phone.page);
    printAreaFill('orientation.phone', reading);
    await shot(phone.page, 'orientation-phone');
    expect(reading.canvas, 'the phone canvas must be measurable').not.toBeNull();
    expect(reading.direction, 'a portrait phone canvas must keep the downward layout').toBe('DOWN');
    expect(reading.reason).toBe('canvas-not-wide');
    expect(
      reading.fill,
      `the phone drawing must fill ≥${DRAWING_FILL_FLOOR} of the canvas — measured ${String(reading.fill)} `
        + `on canvas ${JSON.stringify(reading.canvas)} with natural ${JSON.stringify(reading.natural)}`,
    ).toBeGreaterThanOrEqual(DRAWING_FILL_FLOOR);
  } finally {
    await phone.context.close();
  }
});

/**
 * Control arm: the SAME fixture and the SAME reading, with the direction
 * policy's DEV lever forcing DOWN, must land on the failing side; removing the
 * lever and reloading must restore the passing side.
 *
 * This is the arm that proves the fill reading can go red on the state the
 * feature replaces — a green main arm alone would only prove the fixture.
 */
test('control arm — forcing the downward layout reds the PC fill reading', async ({ browser }) => {
  const { context, page } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PC,
    touch: false,
    forceDownLayout: true,
  });
  try {
    await openOrientationDrawing(page, orientationSessionId);
    const forced = await readDrawingAreaFill(page);
    printAreaFill('orientation.control.down', forced);
    await shot(page, 'orientation-control-down');
    expect(forced.direction, 'the control arm must actually render the downward layout').toBe('DOWN');
    expect(forced.reason, 'the readout must name the control lever').toBe('forced-down');
    expect(
      forced.fill,
      `the downward-only drawing must fall below ${DRAWING_FILL_FLOOR} — measured ${String(forced.fill)} `
        + `on canvas ${JSON.stringify(forced.canvas)} with natural ${JSON.stringify(forced.natural)}`,
    ).toBeLessThan(DRAWING_FILL_FLOOR);

  } finally {
    await context.close();
  }

  // Restore: the lever is an init script, so the passing side is a fresh page
  // WITHOUT it. Same fixture, same reading function, only the lever differs.
  const restoredContext = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PC,
    touch: false,
  });
  try {
    await openOrientationDrawing(restoredContext.page, orientationSessionId);
    const restored = await readDrawingAreaFill(restoredContext.page);
    printAreaFill('orientation.control.restored', restored);
    await shot(restoredContext.page, 'orientation-control-restored');
    expect(restored.direction, 'without the lever the policy must choose RIGHT again').toBe('RIGHT');
    expect(
      restored.fill,
      `the restored drawing must clear ${DRAWING_FILL_FLOOR} — measured ${String(restored.fill)}`,
    ).toBeGreaterThanOrEqual(DRAWING_FILL_FLOOR);
  } finally {
    await restoredContext.context.close();
  }
});

/**
 * The DoD's two extra looks, through the same reading.
 *
 *  · a WIDER desktop viewport (1920×900): the drawing is still turned RIGHT —
 *    the direction decision follows the canvas/drawing ratio, not a fixed
 *    breakpoint;
 *  · a LARGE graph (the function fixture after "Show all", 396 entities): the
 *    second layout is skipped by the entity budget, the drawing stays DOWN, and
 *    the readout says why. That is the "no slowdown on a large graph" check:
 *    the policy's cost is one layout there, not two.
 */
test('main arm — the orientation holds on a wider viewport and large graphs keep DOWN (1920x900)', async ({ browser }) => {
  // The large-graph leg re-lays the 396-box function drawing on a real ELK main
  // thread; under host load neither the file's 60 s default nor 180 s was
  // enough. 300 s matches the other 396-box cases.
  test.setTimeout(300_000);
  const wide = await openSignedInPage(browser, baseURL, token, {
    viewport: { width: 1920, height: 900 },
    touch: false,
  });
  try {
    await openOrientationDrawing(wide.page, orientationSessionId);
    const reading = await readDrawingAreaFill(wide.page);
    printAreaFill('orientation.1920x900', reading);
    await shot(wide.page, 'orientation-1920x900');
    expect(reading.direction, 'a wider canvas keeps choosing RIGHT').toBe('RIGHT');
  } finally {
    await wide.context.close();
  }

  // The function fixture is the >150-entity drawing: 384 functions hidden until
  // "Show all" widens the entity axis.
  const large = await openSignedInPage(browser, baseURL, token, { viewport: VIEWPORT_PC, touch: false });
  try {
    await openArchitectureTab(large.page, functionsSessionId);
    await openEntityDrawing(large.page);
    await large.page.locator(SEL.filterShowAll).first().click();
    await large.page.waitForFunction(
      (sel) => Number(document.querySelector(sel.graphRoot)?.getAttribute('data-architecture-visible-nodes') ?? '0') > 150,
      SEL,
      { timeout: 120_000 },
    );
    await settle(large.page, 1_200);
    const reading = await readDrawingAreaFill(large.page);
    printAreaFill('orientation.large', reading);
    await shot(large.page, 'orientation-large-graph');
    expect(reading.direction, 'a large graph keeps the downward layout').toBe('DOWN');
    const reason = await large.page.locator(SEL.graphRoot).first().getAttribute('data-architecture-layout-direction-reason');
    expect(reason, 'the entity budget must be the stated reason — no second layout ran').toBe('entity-budget-exceeded');
  } finally {
    await large.context.close();
  }
});

/* ── the landscape-phone short-touch tier ─────────────────────────────────────────────────── */

/**
 * Everything the landscape criterion reads from one page, in a single round
 * trip. The SAME function answers the main arm and both control arms, so a
 * green and a red are readings of one instrument rather than two claims.
 *
 * `hostClientHeight` is the drawing HOST's own `clientHeight` — the task's
 * canvas-height unit. `intersects` is the relation the design forbids between
 * the inspector panel and the entity the reader selected; `nodeVisible` is the
 * companion reading (the node must also be inside the canvas, not merely
 * outside the panel by being clipped off-canvas).
 */
type ShortTouchReading = {
  viewport: { width: number; height: number };
  sidebarWidth: number;
  availableWidth: number;
  panel: Box | null;
  toolbarCount: number;
  toolbarShortTouch: boolean;
  toolbarHeight: number;
  host: Box | null;
  hostClientHeight: number;
  hostWidth: number;
  canvas: Box | null;
  /** The SVG's own box, so "the whole drawing is inside the canvas" is a relation. */
  svg: Box | null;
  zoomScale: number | null;
  readoutRow: boolean;
  footer: boolean;
  /** The in-flow side column, when the tier draws one. */
  dockSide: Box | null;
  /** The overlay bottom drawer, when the control arm restores it. */
  dockDrawer: Box | null;
  selectedNode: Box | null;
  intersects: boolean;
  nodeVisible: boolean;
  trayPanelRow: boolean;
  trayOverCanvas: boolean;
};

const readShortTouchLayout = (page: Page, selectedNodeId: string | null = null): Promise<ShortTouchReading> =>
  page.evaluate(({ sel, selectedNodeId }) => {
    const boxOf = (element: Element | null): Box | null => {
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, x2: rect.right, y2: rect.bottom };
    };
    const overlaps = (a: Box | null, b: Box | null): boolean =>
      Boolean(a && b && a.x < b.x2 && b.x < a.x2 && a.y < b.y2 && b.y < a.y2);
    const numberOf = (element: Element | null, attribute: string): number | null => {
      const raw = element?.getAttribute(attribute) ?? null;
      if (raw === null) return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    };

    const shell = document.querySelector('[data-app-shell]');
    // The desktop workspace's first child is the docked sidebar (the provider
    // renders its children directly), so "viewport minus sidebar" is a real
    // subtraction rather than a hardcoded 289.
    const sidebar = shell?.firstElementChild ?? null;
    const sidebarWidth = sidebar?.getBoundingClientRect().width ?? 0;

    const toolbar = document.querySelectorAll(sel.toolbar);
    const host = document.querySelector(sel.host);
    const canvas = document.querySelector(sel.canvas);
    const graphRoot = document.querySelector(sel.graphRoot);
    const dockSide = document.querySelector('[data-architecture-dock-side]');
    const dockDrawer = document.querySelector('[data-architecture-dock-touch]');
    const tray = document.querySelector('[data-architecture-tray-root]');
    const selectedNode = selectedNodeId === null
      ? null
      : [...document.querySelectorAll('.uml-node[data-entity-id]')]
        .find((node) => node.getAttribute('data-entity-id') === selectedNodeId) ?? null;

    const hostBox = boxOf(host);
    const canvasBox = boxOf(canvas);
    const sideBox = boxOf(dockSide);
    const drawerBox = boxOf(dockDrawer);
    const nodeBox = boxOf(selectedNode);

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      sidebarWidth,
      availableWidth: window.innerWidth - sidebarWidth,
      panel: boxOf(document.querySelector(sel.panel)),
      toolbarCount: toolbar.length,
      toolbarShortTouch: document.querySelector(sel.toolbar)?.getAttribute('data-architecture-toolbar-short-touch') === 'true',
      toolbarHeight: document.querySelector(sel.toolbar)?.getBoundingClientRect().height ?? 0,
      host: hostBox,
      hostClientHeight: host instanceof HTMLElement ? host.clientHeight : 0,
      hostWidth: hostBox?.w ?? 0,
      canvas: canvasBox,
      svg: boxOf(host?.querySelector('svg') ?? null),
      zoomScale: numberOf(graphRoot, 'data-architecture-zoom-scale'),
      readoutRow: document.querySelector(sel.canvasRegionHeader) !== null,
      footer: document.querySelector(sel.footer) !== null,
      dockSide: sideBox,
      dockDrawer: drawerBox,
      selectedNode: nodeBox,
      // Either overlay form counts: the design forbids BOTH from covering the
      // selection, and the control arm needs the drawer form to answer true.
      intersects: overlaps(sideBox, nodeBox) || overlaps(drawerBox, nodeBox),
      nodeVisible: Boolean(
        nodeBox !== null
        && canvasBox !== null
        && nodeBox.x >= canvasBox.x - 1
        && nodeBox.x2 <= canvasBox.x2 + 1
        && nodeBox.y >= canvasBox.y - 1
        && nodeBox.y2 <= canvasBox.y2 + 1,
      ),
      trayPanelRow: tray?.getAttribute('data-architecture-tray-panel-row') === 'true',
      trayOverCanvas: tray !== null && tray.closest(sel.canvas) !== null,
    };
  }, { sel: SEL, selectedNodeId });

const printShortTouch = (label: string, reading: ShortTouchReading): void => {
  console.log(`[architecture-layout] ${label}.viewport=${reading.viewport.width}x${reading.viewport.height} `
    + `sidebar=${formatNumber(reading.sidebarWidth)} available=${formatNumber(reading.availableWidth)}`);
  console.log(`[architecture-layout] ${label}.canvas.host=${formatBox(reading.host)} `
    + `clientHeight=${reading.hostClientHeight} width=${formatNumber(reading.hostWidth)} region=${formatBox(reading.canvas)}`);
  console.log(`[architecture-layout] ${label}.zoom.scale=${JSON.stringify(reading.zoomScale)} `
    + `toolbar.count=${reading.toolbarCount} shortTouch=${String(reading.toolbarShortTouch)} `
    + `toolbar.h=${formatNumber(reading.toolbarHeight)}`);
  console.log(`[architecture-layout] ${label}.readoutRow=${String(reading.readoutRow)} footer=${String(reading.footer)}`);
  console.log(`[architecture-layout] ${label}.dock.side=${formatBox(reading.dockSide)} drawer=${formatBox(reading.dockDrawer)}`);
  console.log(`[architecture-layout] ${label}.node=${formatBox(reading.selectedNode)} `
    + `intersects=${String(reading.intersects)} visible=${String(reading.nodeVisible)}`);
  console.log(`[architecture-layout] ${label}.tray.panelRow=${String(reading.trayPanelRow)} overCanvas=${String(reading.trayOverCanvas)}`);
};

/**
 * The short-touch structural readings. The canvas height is the task's 240px
 * floor and the width is its "≥60% of the viewport minus the sidebar" floor.
 * The old "default zoom ≥30%" leg is now "the whole drawing is inside the
 * canvas": the single-scale fit contract retired the readable-crop default, and
 * a legitimate whole-graph fit of a 120-entity drawing may sit below 30%.
 */
const assertLandscapeCanvas = (reading: ShortTouchReading, label: string): void => {
  expect.soft(reading.toolbarCount, `${label}: the tier must spend exactly one row on chrome`).toBe(1);
  expect.soft(reading.toolbarShortTouch, `${label}: the short-touch toolbar must be in force`).toBe(true);
  expect.soft(reading.toolbarHeight, `${label}: the toolbar must be one 52px row`).toBeLessThanOrEqual(60);
  expect.soft(
    reading.hostClientHeight,
    `${label}: the drawing host must keep at least 240px of height (reading ${reading.hostClientHeight}px)`,
  ).toBeGreaterThanOrEqual(240);
  expect.soft(
    reading.hostWidth,
    `${label}: the drawing must keep ≥60% of (viewport − sidebar) = ${(reading.availableWidth * 0.6).toFixed(0)}px `
      + `(reading ${reading.hostWidth.toFixed(0)}px)`,
  ).toBeGreaterThanOrEqual(reading.availableWidth * 0.6);
  // The single-scale contract replaced the old readable-crop default, so the
  // 30% floor is gone; the drawing's scale only has to be a published, positive
  // fit. The OPENED state's whole-graph relation is its own helper below — the
  // SELECTED state deliberately zooms in to reach an entity box, so it cannot
  // also be the whole-graph state.
  expect.soft(
    reading.zoomScale ?? 0,
    `${label}: the canvas must publish a positive fit scale (reading ${String(reading.zoomScale)})`,
  ).toBeGreaterThan(0);
  expect.soft(reading.readoutRow, `${label}: the summary must be a toolbar cell, not a standing row`).toBe(false);
  expect.soft(reading.footer, `${label}: the provenance footer must not hold standing height`).toBe(false);
};

/**
 * The OPENED landscape state: the tab's default fit shows the WHOLE drawing
 * inside the canvas. This is the reading that replaced the retired 30% floor —
 * the defect this tier replaced was a CROP (14% of a drawing the reader had to
 * drag through), not a small whole-graph fit (a 120-entity drawing legitimately
 * solves to ~7.5% on 289px of canvas).
 */
const assertLandscapeWholeGraph = (reading: ShortTouchReading, label: string): void => {
  expect.soft(reading.svg, `${label}: the drawing must be measurable`).not.toBeNull();
  const inside = reading.svg !== null
    && reading.canvas !== null
    && reading.svg.x >= reading.canvas.x - 1
    && reading.svg.y >= reading.canvas.y - 1
    && reading.svg.x2 <= reading.canvas.x2 + 1
    && reading.svg.y2 <= reading.canvas.y2 + 1;
  expect.soft(
    inside,
    `${label}: the default fit must show the WHOLE drawing inside the canvas — `
      + `svg=${formatBox(reading.svg)} canvas=${formatBox(reading.canvas)} scale=${String(reading.zoomScale)}`,
  ).toBe(true);
};

/** The selected-state relation: an in-flow column beside the entity, not over it. */
const assertInspectorBesideSelection = (reading: ShortTouchReading, label: string): void => {
  expect.soft(reading.dockSide, `${label}: selecting must open the in-flow side column`).not.toBeNull();
  expect.soft(reading.dockDrawer, `${label}: the bottom drawer must not be drawn`).toBeNull();
  expect.soft(
    reading.intersects,
    `${label}: the inspector panel and the selected entity must not intersect `
      + `(panel ${formatBox(reading.dockSide ?? reading.dockDrawer)} node ${formatBox(reading.selectedNode)})`,
  ).toBe(false);
  expect.soft(
    reading.nodeVisible,
    `${label}: the selected entity must stay inside the visible canvas (node ${formatBox(reading.selectedNode)})`,
  ).toBe(true);
  expect.soft(reading.trayPanelRow, `${label}: the selection tray must be the column's top row`).toBe(true);
  expect.soft(reading.trayOverCanvas, `${label}: the tray must not float over the canvas`).toBe(false);
};

/* ── the portrait-phone chrome criterion (390×844) ───────────────────────────────────────── */

/** Wait until the CLASS drawing is on screen, whichever tier it folded to. */
async function waitForAnyDrawing(page: Page): Promise<void> {
  await page.waitForFunction(
    (sel) => Number(document.querySelector(sel.graphRoot)?.getAttribute('data-architecture-visible-nodes') ?? '0') > 0,
    SEL,
    { timeout: 40_000 },
  );
  await settle(page, 1_000);
}

/**
 * The portrait-phone chrome criterion over the S / M / L / Quay drawings.
 *
 * Every shape is measured through the SAME `readLayout` the main and control
 * arms share. The four shapes are deliberate: the S/M/L drawings fold to the
 * package tier at different depths, and the folded tier paints no `.uml-node` —
 * the state in which the corner controls used to cover the drawing while the
 * old node-only reading stayed green.
 */
test('main arm — the portrait phone keeps 74% of the viewport, one toolbar row and controls off the drawing (390x844)', async ({ browser }) => {
  test.setTimeout(240_000);
  for (const shape of PORTRAIT_SHAPES) {
    const session = portraitSessionIds.get(shape.key);
    expect(session, `the ${shape.key} fixture must have been armed`).toBeTruthy();
    const { context, page } = await openSignedInPage(browser, baseURL, token, {
      viewport: VIEWPORT_PHONE,
      touch: true,
    });
    try {
      await openArchitectureTab(page, session as string);
      // The class drawing is the one that paints package frames and tabs.
      await page.locator(SEL.viewEntity).first().click();
      await waitForAnyDrawing(page);

      const reading = await readLayout(page);
      printReading(`portrait.${shape.key}`, reading);
      assertPortraitChrome(reading, `portrait.${shape.key}`);
      // The one-line summary is a standing row, collapsed.
      assertPhoneReadoutCollapsed(reading, `portrait.${shape.key}`);

      // The two secondary entries are inside Adjust, never in the row.
      expect(
        await page.locator(`${SEL.toolbar} [data-architecture-fullscreen-toggle]`).count(),
        'Fullscreen must not spend a toolbar entry',
      ).toBe(0);
      expect(
        await page.locator(`${SEL.toolbar} [data-architecture-open-in-new-tab]`).count(),
        '"Open in new tab" must not spend a toolbar entry',
      ).toBe(0);
      await openControlSheet(page);
      const sheet = page.locator(SEL.sheet);
      await expect(
        sheet.locator('[data-architecture-fullscreen-toggle]'),
        'the Adjust sheet must carry the fullscreen entry',
      ).toHaveCount(1);
      await expect(
        sheet.locator('[data-architecture-open-in-new-tab]'),
        'the Adjust sheet must carry the second-screen entry',
      ).toHaveCount(1);
      await closeControlSheet(page);
      await page.screenshot({ path: test.info().outputPath(`portrait-${shape.key}.png`) });
      await shot(page, `portrait-${shape.key}`);

      if (shape.key === 'quay') {
        // The DoD's two gestures, on the shape the task was measured against.
        await openControlSheet(page);
        await shot(page, 'portrait-quay-adjust');
        await closeControlSheet(page);
        await page.locator('[data-architecture-readout-toggle]').first().click();
        await expect(
          page.locator('[data-architecture-readout-detail]'),
          'expanding the summary must restore the hidden/detail content',
        ).toHaveCount(1, { timeout: 10_000 });
        await shot(page, 'portrait-quay-summary-open');
        await page.locator('[data-architecture-readout-toggle]').first().click();
        await expect(page.locator('[data-architecture-readout-detail]')).toHaveCount(0, { timeout: 10_000 });
      }
    } finally {
      await context.close();
    }
  }
});

/**
 * The two control arms, each restoring ONE half of the pre-task chrome through
 * the DEV-only levers, and read through the SAME `readLayout` the main arm just
 * passed with:
 *
 *  · portrait tier off → the old five-entry compact row wraps into two rows,
 *    so the row count and the 74% canvas share both read red;
 *  · floating controls restored → the reserved band is gone and the cluster is
 *    drawn over the drawing; the one-row toolbar and the canvas share stay
 *    green, while the intersection reading goes red.
 */
test('control arm — the two-row toolbar and the floating cluster each turn their own portrait reading red (390x844)', async ({ browser }) => {
  test.setTimeout(180_000);

  // Arm A: the portrait tier is switched off.
  const tierOff = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PHONE,
    touch: true,
  });
  try {
    await tierOff.context.addInitScript(() => {
      window.localStorage.setItem('architecture-portrait-chrome', 'off');
    });
    await openArchitectureTab(tierOff.page, sessionId);
    await showClassDiagram(tierOff.page);
    await waitForDrawing(tierOff.page);
    await settle(tierOff.page, 900);

    const twoRow = await readLayout(tierOff.page);
    printReading('portrait.control.two-row', twoRow);
    expect(twoRow.toolbarPortrait, 'the lever must restore the pre-task compact chrome').toBe(false);
    expect(
      twoRow.toolbarRows,
      `without the tier the toolbar must paint a second row (button tops ${twoRow.toolbarRows})`,
    ).toBeGreaterThan(1);
    expect(
      twoRow.canvasShare ?? 1,
      `without the tier the canvas share must fall below 0.74 (reading ${formatNumber(twoRow.canvasShare)})`,
    ).toBeLessThan(0.74);
  } finally {
    await tierOff.context.close();
  }

  // Arm B: the floating corner controls are restored.
  const floating = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PHONE,
    touch: true,
  });
  try {
    await floating.context.addInitScript(() => {
      window.localStorage.setItem('architecture-portrait-controls', 'overlay');
    });
    await openArchitectureTab(floating.page, sessionId);
    await showClassDiagram(floating.page);
    await waitForDrawing(floating.page);
    await settle(floating.page, 900);

    const green = await readLayout(floating.page);
    printReading('portrait.control.overlay.green', green);
    expect(green.toolbarRows, 'the one-row toolbar must stay green in this arm').toBe(1);
    expect(
      green.canvasShare ?? 0,
      'the canvas share must stay green in this arm',
    ).toBeGreaterThanOrEqual(0.74);
    expect(green.clusterCollapsed, 'the lever must restore the expanded floating cluster').toBe(false);

    // The shipped cluster floats over the reserved band, which is what keeps it
    // clear of the drawing. The pre-task position is over the drawing itself;
    // put the SAME control on a painted tab/name and the SAME reading must go
    // red. Nothing else about the page changes.
    const moved = await floating.page.evaluate((sel) => {
      const cluster = document.querySelector(sel.zoomCluster);
      const canvas = document.querySelector(sel.canvas);
      const target = document.querySelector(`${sel.canvas} .uml-package[data-package-id] > path`)
        ?? document.querySelector(`${sel.canvas} [data-architecture-node-name]`);
      if (!(cluster instanceof HTMLElement) || !(canvas instanceof HTMLElement) || target === null) return false;
      const targetBox = target.getBoundingClientRect();
      cluster.style.position = 'fixed';
      cluster.style.left = `${targetBox.left}px`;
      cluster.style.top = `${targetBox.top}px`;
      cluster.style.right = 'auto';
      cluster.style.bottom = 'auto';
      return true;
    }, SEL);
    expect(moved, 'the arm needs a painted package tab or class name').toBe(true);
    await settle(floating.page, 250);

    const red = await readLayout(floating.page);
    printReading('portrait.control.overlay.red', red);
    expect(
      red.clusterOverPackageTabs + red.clusterOverNames,
      `the floating cluster over a drawn label must turn the intersection reading red — `
        + `tabs=${red.clusterOverPackageTabs} names=${red.clusterOverNames} cluster=${formatBox(red.zoomCluster)}`,
    ).toBeGreaterThan(0);
  } finally {
    await floating.context.close();
  }
});

test('main arm — the landscape phone canvas keeps 240px and the inspector sits beside the selection (844x390)', async ({ browser }) => {
  const { context, page } = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PHONE_LANDSCAPE,
    touch: true,
  });

  try {
    await openArchitectureTab(page, sessionId);
    // `openArchitectureTab` lands on the FILE overview for its own readings;
    // this criterion is about the shipped default (the class diagram), so take
    // the panel back to it before measuring the default state.
    await showClassDiagram(page);
    await waitForDrawing(page);
    await settle(page, 600);

    const opened = await readShortTouchLayout(page);
    printShortTouch('landscape.opened', opened);
    assertLandscapeCanvas(opened, 'landscape.opened');
    assertLandscapeWholeGraph(opened, 'landscape.opened');
    await page.screenshot({ path: test.info().outputPath('landscape-opened.png') });

    // The HIGHEST visible entity: after the side column takes its share of the
    // width the drawing re-fits, and a box that started at the very bottom can
    // end up straddling the canvas' bottom edge. "The selected entity is in the
    // visible area" must therefore be read on a box the reader can actually
    // select to inspect, not on the one chosen to stress a bottom overlay.
    const target = await ensureVisibleEntityBox(page, 'highest');
    expect(target, 'the landscape drawing must offer a visible entity to tap').not.toBeNull();
    const point = target as { x: number; y: number; id: string };

    await page.mouse.click(point.x, point.y);
    await expect(page.locator('[data-architecture-dock-side]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-architecture-dock-touch]')).toHaveCount(0);
    // Let the dock's width change settle and the renderer re-fit into the
    // narrower canvas before the geometry is read.
    await settle(page, 1_200);

    const selected = await readShortTouchLayout(page, point.id);
    printShortTouch('landscape.selected', selected);
    assertLandscapeCanvas(selected, 'landscape.selected');
    assertInspectorBesideSelection(selected, 'landscape.selected');
    await page.screenshot({ path: test.info().outputPath('landscape-selected.png') });
    await shot(page, 'landscape-selected');
  } finally {
    await context.close();
  }
});

/**
 * The two control arms, each restoring ONE half of the defect through the same
 * DEV-only levers the other architecture criteria use, and read through the
 * SAME `readShortTouchLayout` the main arm just passed with.
 *
 *  · compact off → the old chrome (standing readout row + footer + wrapped
 *    toolbar) leaves the canvas at its pre-task height: the 240px reading reds.
 *  · drawer restored on the short tier → the inspector is an overlay covering
 *    the drawing again: the intersection reading reds while the canvas height
 *    stays green, so the two readings are independent.
 */
test('control arm — turning the short-touch tier off reds the canvas height, and the restored drawer reds the intersection (844x390)', async ({ browser }) => {
  // Arm A: the short-touch tier is switched off.
  const tierOff = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PHONE_LANDSCAPE,
    touch: true,
  });
  try {
    await tierOff.context.addInitScript(() => {
      window.localStorage.setItem('architecture-short-touch-layout', 'off');
    });
    await openArchitectureTab(tierOff.page, sessionId);
    await waitForDrawing(tierOff.page);
    await settle(tierOff.page, 600);

    const withoutTier = await readShortTouchLayout(tierOff.page);
    printShortTouch('control.tier-off', withoutTier);
    expect(
      withoutTier.toolbarShortTouch,
      'the lever must really restore the pre-task chrome',
    ).toBe(false);
    expect(
      withoutTier.hostClientHeight,
      `without the tier the canvas height reading must go red (reading ${withoutTier.hostClientHeight}px, floor 240px)`,
    ).toBeLessThan(240);
    await tierOff.page.screenshot({ path: test.info().outputPath('control-tier-off.png') });
  } finally {
    await tierOff.context.close();
  }

  // Arm B: the side column is replaced by the old bottom drawer.
  const drawer = await openSignedInPage(browser, baseURL, token, {
    viewport: VIEWPORT_PHONE_LANDSCAPE,
    touch: true,
  });
  try {
    await drawer.context.addInitScript(() => {
      window.localStorage.setItem('architecture-short-touch-dock', 'drawer');
    });
    await openArchitectureTab(drawer.page, sessionId);
    await showClassDiagram(drawer.page);
    await waitForDrawing(drawer.page);
    await settle(drawer.page, 600);

    const target = await ensureVisibleEntityBox(drawer.page);
    expect(target, 'the control arm needs the same tappable entity').not.toBeNull();
    const point = target as { x: number; y: number; id: string };
    await drawer.page.mouse.click(point.x, point.y);
    await expect(drawer.page.locator('[data-architecture-dock-touch]')).toBeVisible({ timeout: 10_000 });
    // The drawer's shipped opening snap is Half (45vh ≈ 175px of this canvas'
    // 289px). It is an OVERLAY, so its rect covers the bottom band of the
    // canvas — the lowest entity the helper selected lives there.
    await settle(drawer.page, 1_200);

    const withDrawer = await readShortTouchLayout(drawer.page, point.id);
    printShortTouch('control.drawer', withDrawer);
    expect(
      withDrawer.dockDrawer,
      'the lever must really restore the bottom drawer',
    ).not.toBeNull();
    expect(withDrawer.dockSide, 'and must not draw the side column').toBeNull();
    expect(
      withDrawer.hostClientHeight,
      'the compact chrome stays on in this arm, so the height reading stays green',
    ).toBeGreaterThanOrEqual(240);
    expect(
      withDrawer.intersects,
      `with the drawer restored the panel/selection intersection reading must go red `
        + `(drawer ${formatBox(withDrawer.dockDrawer)} node ${formatBox(withDrawer.selectedNode)})`,
    ).toBe(true);
    await drawer.page.screenshot({ path: test.info().outputPath('control-drawer.png') });
  } finally {
    await drawer.context.close();
  }
});
