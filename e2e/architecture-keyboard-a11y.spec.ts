import fs from 'node:fs';
import path from 'node:path';

import { expect, request, test } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';

import {
  writeFitContractFixture,
  type FitContractFixtureReading,
} from './support/architectureFixture';
import {
  awaitClientMounted,
  warmClientStartup,
  type RequestFailure,
} from './support/client-startup-warmup';

/**
 * The architecture drawing's keyboard entry and accessibility criterion, in a
 * real browser.
 *
 * WHAT THIS FILE EXISTS FOR. jsdom proves the wiring (the pure start rule, the
 * live region's shape, the blur handler), but it has no layout and no real
 * focus: which entity is "nearest the viewport centre" is a claim about screen
 * rectangles, an `aria-live` region is only meaningful when a screen reader
 * would actually hear it, and a focus ring that survives Tab is exactly the
 * defect this criterion removes. This spec drives Chromium against the L
 * fixture (55 classes, five packages) at the PC viewport the task names:
 *
 *  1. Tab into the canvas starts the cursor on the entity nearest the viewport
 *     centre (the reading recomputes that nearest from the same boxes);
 *  2. after arrow moves the live region is exactly `name, kind, n/m` — no
 *     package, no relation counts, no inspector prose;
 *  3. the focus ring and the selection edge are DIFFERENT computed styles and
 *     different `data-*` states / classes, and the ring disappears when focus
 *     leaves (Tab) or the blank canvas is pressed;
 *  4. the control arm restores each defect in turn (an arbitrary start, the
 *     old long announcement, a ring that survives blur) and the SAME reading
 *     functions go red for it.
 *
 * THE FIXTURE. `writeFitContractFixture` writes the same hub-and-spoke L tree
 * the fit-contract criterion measures (55 classes, five packages) under the
 * run's debug-agent fixture home; the seeded user text names the hub and one
 * leader per package. The class view is opened and zoomed until entity boxes
 * (not the folded package map) are on screen, because that is the state in
 * which entity navigation has entities to stand on.
 */

const RUN_STARTED_AT = Number(process.env.QUAY_E2E_RUN_STARTED_AT) || Date.now();

/** The PC viewport the task names. */
const VIEWPORT_PC = { width: 1440, height: 765 };

const USERNAME = 'architecture-keyboard-a11y-e2e';
const PASSWORD = 'architecture-keyboard-a11y-e2e-pass';
const WORKSPACE_DIR = 'architecture-keyboard-a11y-workspace-l';

/** Where the DoD's screenshots land (git-ignored). */
const SHOTS_DIR = path.resolve(process.cwd(), 'tmp', 'architecture-keyboard-a11y');

/** The DEV lever the control arm writes; mirrors `KEYBOARD_A11Y_STORAGE_KEY`. */
const DEFECT_STORAGE_KEY = 'architecture-keyboard-a11y';

const SEL = {
  panel: '[data-workspace-view="architecture"] [data-architecture-panel]',
  host: '[data-architecture-plantuml]',
  graphRoot: '[data-architecture-plantuml-graph]',
  entityView: '[data-architecture-view-option="entity"]',
  entityNode: '.uml-node[data-entity-id]',
  navRing: '[data-architecture-nav-ring]',
  navFocus: '[data-architecture-nav-focus]',
  selected: '[data-architecture-selected]',
  announcer: '[data-architecture-nav-announcer]',
  zoomIn: '[data-architecture-zoom-in]',
  zoomFit: '[data-architecture-zoom-fit]',
} as const;

const ARCHITECTURE_TAB_LANDING =
  '[role="tab"][data-workspace-tab="architecture"], [aria-haspopup="dialog"][data-workspace-tab]';

type Box = { x: number; y: number; width: number; height: number; right: number; bottom: number };

/** Every reading one keyboard state publishes, taken in a single round trip. */
type KeyboardA11yReading = {
  readonly role: string | null;
  readonly activeDescendant: string | null;
  readonly entityId: string | null;
  readonly isFrame: boolean;
  readonly label: string | null;
  readonly focusIsOnHost: boolean;
  readonly announce: string;
  readonly ring: {
    readonly box: Box;
    readonly className: string;
    readonly strokeDasharray: string;
    readonly strokeWidth: string;
  } | null;
  readonly navFocusState: boolean;
  readonly selectedState: boolean;
  readonly focusClass: boolean;
  readonly selectedClass: boolean;
  readonly selection: {
    readonly entityId: string;
    readonly dataState: string | null;
    readonly strokeDasharray: string;
    readonly strokeWidth: string;
    readonly classes: string;
  } | null;
  readonly nearestEntityId: string | null;
  readonly farthestEntityId: string | null;
  readonly drawnEntityCount: number;
};

/**
 * Read one keyboard state. The nearest/farthest entities are recomputed HERE
 * from the same client rectangles the component measures, so the main arm and
 * the control arm judge the shipped code by one function — and the control arm
 * can only go red because the code and this reading disagree.
 */
async function readKeyboardA11y(page: Page): Promise<KeyboardA11yReading> {
  return page.evaluate((sel) => {
    const host = document.querySelector<HTMLElement>(sel.host);
    const boxOf = (target: Element | null): Box | null => {
      if (target === null) return null;
      const rect = target.getBoundingClientRect();
      return {
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        right: rect.right, bottom: rect.bottom,
      };
    };
    const activeId = host?.getAttribute('aria-activedescendant') ?? null;
    const active = activeId === null ? null : document.getElementById(activeId);
    const ringElement = document.querySelector(sel.navRing);
    const ringStyle = ringElement === null ? null : window.getComputedStyle(ringElement);
    const selectedElement = document.querySelector(`${sel.selected}.arch-selected`)
      ?? document.querySelector('.arch-selected[data-entity-id]');
    const selectedRect = selectedElement?.querySelector('rect') ?? null;
    const selectedStyle = selectedRect === null ? null : window.getComputedStyle(selectedRect);

    // The component's candidate set: drawn entity boxes, minus stubs. Group
    // boxes (`grp::`) ARE candidates — the shipped rule includes them, so the
    // reading must too.
    const candidates: { id: string; left: number; top: number; width: number; height: number }[] = [];
    for (const element of host?.querySelectorAll(sel.entityNode) ?? []) {
      const id = element.getAttribute('data-entity-id') ?? '';
      if (id === '' || id.startsWith('stub::')) continue;
      if ((element as SVGElement).style.display === 'none') continue;
      const rect = element.getBoundingClientRect();
      candidates.push({ id, left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    }
    const hostRect = host?.getBoundingClientRect();
    const centre = {
      x: (hostRect?.left ?? 0) + (host?.clientWidth || hostRect?.width || 0) / 2,
      y: (hostRect?.top ?? 0) + (host?.clientHeight || hostRect?.height || 0) / 2,
    };
    const distanceOf = (item: (typeof candidates)[number]): number =>
      Math.hypot(item.left + item.width / 2 - centre.x, item.top + item.height / 2 - centre.y);
    let nearest: (typeof candidates)[number] | null = null;
    let farthest: (typeof candidates)[number] | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    let farthestDistance = -1;
    for (const candidate of candidates) {
      const distance = distanceOf(candidate);
      if (
        nearest === null
        || distance < nearestDistance
        || (distance === nearestDistance
          && (candidate.top !== nearest.top ? candidate.top < nearest.top
            : candidate.left !== nearest.left ? candidate.left < nearest.left
              : candidate.id < nearest.id))
      ) {
        nearest = candidate;
        nearestDistance = distance;
      }
      if (farthest === null || distance > farthestDistance) {
        farthest = candidate;
        farthestDistance = distance;
      }
    }

    return {
      role: host?.getAttribute('role') ?? null,
      activeDescendant: activeId,
      entityId: active?.getAttribute('data-entity-id') ?? null,
      isFrame: active?.classList.contains('uml-package') ?? false,
      label: active?.querySelector('[data-architecture-label]')?.getAttribute('data-architecture-label') ?? null,
      focusIsOnHost: host !== null && document.activeElement === host,
      announce: document.querySelector(sel.announcer)?.textContent ?? '',
      ring: ringElement === null || ringStyle === null ? null : {
        box: boxOf(ringElement) as Box,
        className: ringElement.getAttribute('class') ?? '',
        strokeDasharray: ringStyle.strokeDasharray,
        strokeWidth: ringStyle.strokeWidth,
      },
      navFocusState: active?.getAttribute('data-architecture-nav-focus') === 'true',
      selectedState: active?.getAttribute('data-architecture-selected') === 'true',
      focusClass: active?.classList.contains('arch-nav-focus') ?? false,
      selectedClass: active?.classList.contains('arch-selected') ?? false,
      selection: selectedElement === null ? null : {
        entityId: selectedElement.getAttribute('data-entity-id') ?? '',
        dataState: selectedElement.getAttribute('data-architecture-selected'),
        strokeDasharray: selectedStyle?.strokeDasharray ?? '',
        strokeWidth: selectedStyle?.strokeWidth ?? '',
        classes: selectedElement.getAttribute('class') ?? '',
      },
      nearestEntityId: nearest?.id ?? null,
      farthestEntityId: farthest?.id ?? null,
      drawnEntityCount: candidates.length,
    };
  }, SEL);
}

/** The live region's shape: `name, kind, n/m`. */
function announcementIsConcise(reading: KeyboardA11yReading): boolean {
  const match = /^(.+), ([^,]+), (\d+)\/(\d+)$/.exec(reading.announce.trim());
  if (match === null) return false;
  if (!reading.announce.includes(reading.label ?? '\u0000')) return false;
  const position = Number(match[3]);
  const total = Number(match[4]);
  if (position < 1 || position > total || total !== reading.drawnEntityCount) return false;
  return !/package|incoming|outgoing/.test(reading.announce);
}

/** The criterion's own start predicate, used by both arms. */
function startsOnNearest(reading: KeyboardA11yReading): boolean {
  return reading.role === 'application'
    && reading.entityId !== null
    && reading.nearestEntityId === reading.entityId;
}

/** Two animation frames plus a beat. */
async function settle(page: Page, ms = 250): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await page.waitForTimeout(ms);
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
}

/* ── the server's own faces ─────────────────────────────────────────────────────────────── */

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
    seed: { title: 'Architecture keyboard accessibility', userText: `Review ${mentioned} before the refactor.` },
    steps: [{ at: 0, op: 'wait' }],
    expect: { rows: { delta: 0 }, content: { mustContain: [seedIdentifiers[0] ?? ''] } },
  };
  const response = await api.post('/api/debug-agent/scenarios', { data: { projectPath, scenario } });
  const body = await response.json().catch(() => null);
  if (!response.ok()) throw new Error(`arming failed (${response.status()}): ${JSON.stringify(body)}`);
  const id = body?.data?.sessionId;
  if (typeof id !== 'string') throw new Error(`arming returned no sessionId: ${JSON.stringify(body)}`);
  return id;
}

/* ── page driving ───────────────────────────────────────────────────────────────────────── */

const startupEvidence: {
  pageErrors: string[];
  consoleErrors: string[];
  requestFailures: RequestFailure[];
  warmup: null;
} = { pageErrors: [], consoleErrors: [], requestFailures: [], warmup: null };

let baseURL = '';
let token = '';
let sessionId = '';
let fixture: FitContractFixtureReading | null = null;
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
  const workspace = path.join(fixtureHome, WORKSPACE_DIR);
  fixture = writeFitContractFixture(workspace, {
    entityCount: 55,
    entityKind: 'class',
    packageCount: 5,
    labelStem: 'Keyboard',
  });

  const bootstrap = await request.newContext({ baseURL });
  token = await createAccount(bootstrap);
  await bootstrap.dispose();

  const api = await request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  try {
    sessionId = await armScenario(api, workspace, fixture.seedIdentifiers);
    console.log(
      `[architecture-keyboard-a11y] fixture=L entities=${fixture.entityTotal} `
        + `seeds=${fixture.seedIdentifiers.length} session=${sessionId}`,
    );
  } finally {
    await api.dispose();
  }
});

async function openContext(browser: Browser, defect: string | null): Promise<BrowserContext> {
  const dataDir = process.env.QUAY_E2E_DATA_DIR;
  if (!dataDir) throw new Error('playwright.config.ts must publish QUAY_E2E_DATA_DIR');
  warmClientPromise ??= warmClientStartup(baseURL, dataDir);
  await warmClientPromise;
  const context = await browser.newContext({ baseURL, viewport: VIEWPORT_PC, hasTouch: false });
  await context.addInitScript(
    ({ authToken, defectValue }: { authToken: string; defectValue: string | null }) => {
      window.localStorage.setItem('auth-token', authToken);
      window.localStorage.setItem('userLanguage', 'en');
      // The DEV-only lever the control arm pulls; a fresh context makes the
      // first paint read it.
      if (defectValue === null) window.localStorage.removeItem('architecture-keyboard-a11y');
      else window.localStorage.setItem('architecture-keyboard-a11y', defectValue);
    },
    { authToken: token, defectValue: defect },
  );
  return context;
}

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
  await awaitClientMounted(page, ARCHITECTURE_TAB_LANDING, 60_000, startupEvidence);
  return page;
}

/** Open the class drawing and zoom until entity boxes (not the folded map) are drawn. */
async function openClassDrawing(page: Page): Promise<void> {
  const direct = page.locator('[role="tab"][data-workspace-tab="architecture"]').first();
  if (await direct.count() === 0 || !(await direct.isVisible())) {
    await page.locator('[aria-haspopup="dialog"][data-workspace-tab]').first().click();
    const inDialog = page.locator('[role="dialog"] [data-workspace-tab="architecture"]').first();
    await expect(inDialog).toBeVisible({ timeout: 15_000 });
    await inDialog.click();
  } else {
    await direct.click();
  }
  await expect(page.locator(SEL.panel)).toBeVisible({ timeout: 30_000 });

  const entityView = page.locator(SEL.entityView).first();
  if (await entityView.count() > 0 && await entityView.isVisible()) {
    await entityView.click();
    await settle(page);
  }
  await page.waitForFunction(
    ({ root, host, node }) => Number(document.querySelector(root)?.getAttribute('data-architecture-visible-nodes') ?? '0') > 0
      && (document.querySelector(host)?.querySelectorAll(node).length ?? 0) > 0,
    { root: SEL.graphRoot, host: SEL.host, node: SEL.entityNode },
    { timeout: 40_000 },
  );

  // The fitted L drawing is a folded package map. Zoom in through the same
  // control a reader uses until at least two entity boxes are on screen.
  for (let step = 0; step < 10; step += 1) {
    const visible = await page.evaluate((sel) => [...document.querySelectorAll(sel.entityNode)]
      .filter((element) => (element as SVGElement).style.display !== 'none'
        && element.querySelector('[data-architecture-label]') !== null).length, SEL);
    if (visible >= 2) break;
    const zoomIn = page.locator(SEL.zoomIn).first();
    if (await zoomIn.count() === 0) break;
    await zoomIn.click({ timeout: 10_000 }).catch(() => undefined);
    await settle(page, 350);
  }
  await page.waitForFunction((sel) => [...document.querySelectorAll(sel.entityNode)]
    .filter((element) => (element as SVGElement).style.display !== 'none'
      && element.querySelector('[data-architecture-label]') !== null).length >= 2, SEL, {
    timeout: 30_000,
  });
  await settle(page, 500);
}

/**
 * Tab into the canvas from the focusable element that immediately precedes it
 * in the document. This is the gesture the criterion names — no scripted
 * `focus()` on the canvas itself — and the document-order neighbour is what a
 * reader would reach it from, whatever controls the toolbar happens to draw
 * around it.
 */
async function tabToCanvas(page: Page): Promise<void> {
  const positioned = await page.evaluate((sel) => {
    const host = document.querySelector(sel.host);
    if (host === null) return 'no canvas';
    const focusables = [...document.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
        + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0
        && style.display !== 'none' && style.visibility !== 'hidden';
    });
    const index = focusables.indexOf(host as HTMLElement);
    if (index <= 0) return `canvas has no previous focus target (index=${index})`;
    focusables[index - 1].focus();
    return focusables[index - 1].tagName;
  }, SEL);
  if (positioned === 'no canvas') throw new Error('the architecture canvas is not mounted');

  await page.keyboard.press('Tab');
  const reached = await page.evaluate((sel) => document.activeElement?.matches(sel.host) ?? false, SEL);
  if (!reached) {
    const active = await page.evaluate(() => {
      const element = document.activeElement;
      return {
        tag: element?.tagName ?? null,
        attrs: element === null ? null : [...element.attributes].map((attribute) => `${attribute.name}=${attribute.value}`),
      };
    });
    throw new Error(`Tab did not reach the canvas from ${positioned}: ${JSON.stringify(active)}`);
  }
  await settle(page, 200);
}

/** Leave the canvas with Tab and read the state after blur. */
async function tabAway(page: Page): Promise<KeyboardA11yReading> {
  await page.keyboard.press('Tab');
  await settle(page, 200);
  return readKeyboardA11y(page);
}

/* ── the main arm ───────────────────────────────────────────────────────────────────────── */

test('main arm — Tab starts on the nearest entity, the live region is name/kind/n-of-m, and blur clears the ring (1440x765)', async ({ browser }) => {
  const context = await openContext(browser, null);
  try {
    const page = await openSession(context);
    await openClassDrawing(page);
    await tabToCanvas(page);

    let reading = await readKeyboardA11y(page);
    console.log(`[architecture-keyboard-a11y] start ${JSON.stringify(reading)}`);
    expect(reading.focusIsOnHost, 'Tab must leave focus on the canvas').toBe(true);
    expect(startsOnNearest(reading), `the cursor must start on the nearest entity: ${JSON.stringify(reading)}`).toBe(true);
    expect(reading.entityId, 'the start must be a drawn entity, not a frame').not.toBeNull();
    expect(reading.isFrame, 'the start is an entity').toBe(false);
    expect(announcementIsConcise(reading), `the live region must be name, kind, n/m: ${reading.announce}`).toBe(true);
    expect(reading.ring, 'the focused entity must carry a ring').not.toBeNull();
    expect(reading.ring?.className ?? '', 'the ring carries the focus class').toContain('arch-nav-ring');
    expect(reading.navFocusState, 'the focus state is published as data-architecture-nav-focus').toBe(true);
    expect(reading.selectedState, 'nothing is selected yet').toBe(false);
    await shot(page, '01-tab-start-nearest');

    // Arrow moves keep the concise reading and never paint a second ring.
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
      await page.keyboard.press(key);
      await settle(page, 150);
      const moved = await readKeyboardA11y(page);
      expect(moved.focusIsOnHost, `${key} keeps focus on the canvas`).toBe(true);
      expect(moved.entityId, `${key} keeps an active entity`).not.toBeNull();
      if (!moved.isFrame) {
        expect(announcementIsConcise(moved), `${key}: ${moved.announce}`).toBe(true);
      }
      expect(
        await page.locator(SEL.navRing).count(),
        `${key} must leave exactly one focus ring`,
      ).toBe(1);
    }
    reading = await readKeyboardA11y(page);
    await shot(page, '02-arrow-moved');

    // Enter selects: focus and selection are separate states with separate
    // classes, and their computed strokes differ.
    const beforeSelect = reading;
    await page.keyboard.press('Enter');
    await expect(page.locator('[role="complementary"]'), 'Enter opens the inspector').toBeVisible({ timeout: 10_000 });
    await settle(page, 250);
    const selected = await readKeyboardA11y(page);
    expect(selected.entityId, 'the cursor still stands on the selected entity').toBe(beforeSelect.entityId);
    expect(selected.selectedState, 'the selection publishes data-architecture-selected').toBe(true);
    expect(selected.selectedClass, 'the selection carries the arch-selected class').toBe(true);
    expect(selected.navFocusState, 'the cursor still publishes its focus state').toBe(true);
    expect(selected.focusClass, 'the cursor still carries arch-nav-focus').toBe(true);
    expect(selected.selection, 'a selected node must be drawn').not.toBeNull();
    expect(selected.selection?.strokeDasharray ?? '', 'the selection is a SOLID edge').toBe('none');
    expect(selected.ring?.strokeDasharray ?? '', 'the focus ring is DASHED').not.toBe('none');
    expect(
      selected.ring?.strokeDasharray,
      `focus and selection must not share a computed stroke (${JSON.stringify(selected.ring)} vs ${JSON.stringify(selected.selection)})`,
    ).not.toBe(selected.selection?.strokeDasharray);
    expect(selected.ring?.strokeWidth, 'the ring is the thicker outline').not.toBe(selected.selection?.strokeWidth);
    await shot(page, '03-focus-vs-selection');

    // Tab away: the focus ring and its state go, the selection stays.
    const blurred = await tabAway(page);
    console.log(`[architecture-keyboard-a11y] after Tab ${JSON.stringify(blurred)}`);
    expect(blurred.focusIsOnHost, 'Tab moved focus away').toBe(false);
    expect(blurred.role, 'blur returns the canvas to role="img"').toBe('img');
    expect(blurred.activeDescendant, 'blur clears the active descendant').toBeNull();
    expect(blurred.ring, 'Tab away removes the focus ring').toBeNull();
    expect(blurred.navFocusState, 'and its focus state').toBe(false);
    expect(blurred.selection?.entityId, 'the selection survives the focus leaving').toBe(beforeSelect.entityId);
    expect(blurred.selection?.dataState, 'and its own data state survives too').toBe('true');
    await shot(page, '04-tab-away-ring-gone');

    // A press on the blank canvas is the other way to leave the ring behind:
    // the pointer focuses the host for panning and paints nothing.
    const hostBox = await page.locator(SEL.host).boundingBox();
    expect(hostBox, 'the canvas must have a box').not.toBeNull();
    await page.mouse.click((hostBox as Box).x + 4, (hostBox as Box).y + 4);
    await settle(page, 200);
    const afterBlank = await readKeyboardA11y(page);
    expect(afterBlank.ring, 'a blank press leaves no focus ring').toBeNull();
    expect(afterBlank.role, 'a blank press does not enter keyboard navigation').toBe('img');
    await shot(page, '05-blank-press-ring-gone');
  } finally {
    await context.close();
  }
});

/* ── the control arm ───────────────────────────────────────────────────────────────────── */

/**
 * Each defect is restored alone, in a fresh context, and read with the SAME
 * functions the main arm uses. A defect passes the arm only by making its own
 * reading go red; the main arm's green is the control.
 */
for (const defect of ['farthest-start', 'verbose-announce', 'keep-ring-on-blur'] as const) {
  test(`control arm — ${defect} makes its reading go red`, async ({ browser }) => {
    const context = await openContext(browser, defect);
    try {
      const page = await openSession(context);
      await openClassDrawing(page);
      await tabToCanvas(page);
      const reading = await readKeyboardA11y(page);
      console.log(`[architecture-keyboard-a11y] control=${defect} ${JSON.stringify(reading)}`);

      if (defect === 'farthest-start') {
        expect(
          reading.entityId,
          'the control starts on the entity farthest from the centre',
        ).toBe(reading.farthestEntityId);
        expect(startsOnNearest(reading), 'the criterion must read FALSE with an arbitrary start').toBe(false);
      }
      if (defect === 'verbose-announce') {
        expect(announcementIsConcise(reading), 'the criterion must read FALSE with the long announcement').toBe(false);
        expect(reading.announce, 'the restored announcement names the package and the counts').toMatch(/package|outgoing|incoming/);
      }
      if (defect === 'keep-ring-on-blur') {
        const blurred = await tabAway(page);
        expect(blurred.ring, 'the ring must survive blur (the restored defect)').not.toBeNull();
      }
      await shot(page, `control-${defect}`);
    } finally {
      await context.close();
    }
  });
}

test.afterAll(() => {
  console.log(
    `[architecture-keyboard-a11y] elapsed=${Date.now() - RUN_STARTED_AT}ms `
      + `pageErrors=${startupEvidence.pageErrors.length} consoleErrors=${startupEvidence.consoleErrors.length} `
      + `requestFailures=${startupEvidence.requestFailures.length}`,
  );
});
