import fs from 'node:fs';
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
 * The architecture drawing's keyboard criterion, on a real page.
 *
 * WHAT THIS FILE EXISTS FOR. The jsdom test proves the key handler's wiring, but
 * jsdom has no layout: `aria-activedescendant` can point at an element whose box
 * is off-screen, and a ring painted in SVG user units can be nowhere near the
 * box a browser would draw. This spec drives the real Chromium against the real
 * client and server, entering the entity-navigation state with Tab (the gesture
 * the criterion names), walking it with arrow keys, selecting, multi-selecting,
 * and reading the things only a laid-out page has:
 *
 *  1. the canvas stops being `role="img"` and names an active descendant that
 *     resolves to a drawn entity, whose `aria-live` reading carries its label;
 *  2. the focus ring — a separate SVG rect, 3px outside by a 2px gap — has a
 *     SCREEN rectangle inside the canvas's viewport after the cursor moves;
 *  3. Enter opens the inspector for the entity the cursor stands on, and
 *     Shift+Enter puts a second entity into the selection tray;
 *  4. the control arm: with the `aria-activedescendant` update removed from the
 *     page, the same "current entity is readable" reading lands on the failing
 *     side; restoring it lands back on the passing side.
 *
 * THE FIXTURE. `e2e/support/architectureFixture.ts` writes the `.archguard` tree
 * under the run's debug-agent fixture home before the scenario is armed; the
 * seeded user text names the fixture's seed entities so the server's extractor
 * resolves them. The class view is opened and the readable Focus mode applied,
 * because that is the drawing state in which the entity boxes are actually on
 * screen (the whole-graph fit folds them into package frames at this size).
 */

const RUN_STARTED_AT = Number(process.env.QUAY_E2E_RUN_STARTED_AT) || Date.now();

/** The PC viewport the task names. */
const VIEWPORT_PC = { width: 1440, height: 765 };

/** The account this run owns; distinct from every sibling spec's. */
const USERNAME = 'architecture-keyboard-e2e';
const PASSWORD = 'architecture-keyboard-e2e-pass';

/** Where the DoD's screenshots land (git-ignored). */
const SHOTS_DIR = path.resolve(process.cwd(), 'tmp', 'architecture-keyboard-entity-navigation');

const SEL = {
  panel: '[data-workspace-view="architecture"] [data-architecture-panel]',
  host: '[data-architecture-plantuml]',
  graphRoot: '[data-architecture-plantuml-graph]',
  entityView: '[data-architecture-view-option="entity"]',
  readableOverview: '[data-architecture-readable-overview-mode]',
  entityNode: '.uml-node[data-entity-id]',
  navRing: '[data-architecture-nav-ring]',
  announcer: '[data-architecture-nav-announcer]',
  trayPill: '[data-architecture-tray-pill]',
  trayItem: '[data-architecture-tray-item]',
  toast: '[data-architecture-curation-toast]',
  undo: '[data-architecture-curation-undo]',
};

/** The architecture tab's landing element on either tier (a pill or the picker). */
const ARCHITECTURE_TAB_LANDING =
  '[role="tab"][data-workspace-tab="architecture"], [aria-haspopup="dialog"][data-workspace-tab]';

type Box = { x: number; y: number; width: number; height: number; right: number; bottom: number };

/** Everything one keyboard state reports, in a single round trip. */
type KeyboardReading = {
  role: string | null;
  activeDescendant: string | null;
  entityId: string | null;
  isFrame: boolean;
  label: string | null;
  ring: Box | null;
  host: Box | null;
  announce: string;
  trayPill: string | null;
  inspectorText: string | null;
};

async function readKeyboard(page: Page): Promise<KeyboardReading> {
  return page.evaluate((sel) => {
    const host = document.querySelector(sel.host);
    const active = host?.getAttribute('aria-activedescendant') ?? null;
    const element = active === null ? null : document.getElementById(active);
    const boxOf = (target: Element | null): Box | null => {
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
    return {
      role: host?.getAttribute('role') ?? null,
      activeDescendant: active,
      entityId: element?.getAttribute('data-entity-id') ?? null,
      isFrame: element?.classList.contains('uml-package') ?? false,
      label: element?.querySelector('[data-architecture-label]')?.getAttribute('data-architecture-label') ?? null,
      ring: boxOf(document.querySelector(sel.navRing)),
      host: boxOf(host),
      announce: document.querySelector(sel.announcer)?.textContent ?? '',
      trayPill: document.querySelector(sel.trayPill)?.textContent ?? null,
      inspectorText: document.querySelector('[role="complementary"]')?.textContent ?? null,
    };
  }, SEL);
}

/**
 * The criterion's own pass/fail predicate: the canvas names a drawn entity and
 * the polite region names it too. The control arm removes the attribute and
 * re-runs THIS function, so both sides read the same thing.
 */
function isCurrentEntityReadable(reading: KeyboardReading): boolean {
  return reading.role === 'application'
    && reading.activeDescendant !== null
    && reading.entityId !== null
    && !reading.isFrame
    && reading.label !== null
    && reading.announce.includes(reading.label);
}

/** Two animation frames plus a beat: the semantic fit and its repaint land inside it. */
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

/** Create (or sign back into) the run's account and complete onboarding. */
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

/** Arm a scenario whose seeded user text names the fixture's seed entities. */
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
    seed: { title: 'Architecture keyboard navigation', userText },
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
): Promise<{ context: BrowserContext; page: Page }> {
  const dataDir = process.env.QUAY_E2E_DATA_DIR;
  if (!dataDir) throw new Error('playwright.config.ts must publish QUAY_E2E_DATA_DIR');
  warmClientPromise ??= warmClientStartup(baseURL, dataDir);

  const context = await browser.newContext({
    baseURL,
    viewport: VIEWPORT_PC,
    hasTouch: false,
  });
  await context.addInitScript(
    ({ authKey, authToken }: { authKey: string; authToken: string }) => {
      window.localStorage.setItem(authKey, authToken);
      window.localStorage.setItem('userLanguage', 'en');
    },
    { authKey: 'auth-token', authToken: token },
  );
  const page = await context.newPage();
  page.on('pageerror', (error) => startupEvidence.pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') startupEvidence.consoleErrors.push(message.text());
  });
  return { context, page };
}

/** Open the architecture tab on the entity (class) view, focused readably. */
async function openClassDrawing(page: Page, sessionId: string): Promise<void> {
  try {
    await page.goto(`/session/${sessionId}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  } catch (error) {
    console.log(
      `[architecture-keyboard] navigation did not return in 20s (the mount probe decides): `
        + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await awaitClientMounted(page, ARCHITECTURE_TAB_LANDING, 25_000, startupEvidence);

  const desktopTab = page.locator(`[role="tab"][data-workspace-tab="architecture"]`);
  if ((await desktopTab.count()) > 0 && (await desktopTab.first().isVisible())) {
    await desktopTab.first().click();
  } else {
    await page.locator('[aria-haspopup="dialog"][data-workspace-tab]').first().click();
    await page.locator('[role="dialog"] [data-workspace-tab="architecture"]').first().click();
  }
  await expect(page.locator(SEL.panel), 'the architecture tab must open').toBeVisible({ timeout: 30_000 });

  // The class drawing, zoomed to its readable Focus mode, is the state that
  // draws entity boxes with names (the whole-graph fit folds them away).
  await page.locator(SEL.entityView).first().click();
  // Wait on the DRAWING, not on the radio: the entity ids carry the
  // `.ts.<Name>` suffix the file graph never has.
  await page.waitForFunction(
    () => [...document.querySelectorAll('.uml-node[data-entity-id]')]
      .some((node) => /\.ts\.[^./]+$/.test(node.getAttribute('data-entity-id') ?? '')),
    undefined,
    { timeout: 40_000 },
  );
  await page.waitForFunction(
    (sel) => document.querySelector(sel.graphRoot)?.getAttribute('data-architecture-view') === 'hierarchy',
    SEL,
    { timeout: 30_000 },
  );
  await page.locator('[data-architecture-readable-focus-mode]').first().click();
  // One or two deliberate zoom-ins make sure the tier keeps names on screen.
  for (let step = 0; step < 4; step += 1) {
    const named = await page.evaluate(
      (sel) => [...document.querySelectorAll(sel.entityNode)].some(
        (node) => (node as SVGElement).style.display !== 'none'
          && node.querySelector('[data-architecture-label]') !== null,
      ),
      SEL,
    );
    if (named) break;
    await page.locator('[data-architecture-zoom-in]').first().click();
    await settle(page);
  }
  await page.waitForFunction(
    (sel) => [...document.querySelectorAll(sel.entityNode)].some(
      (node) => (node as SVGElement).style.display !== 'none'
        && node.querySelector('[data-architecture-label]') !== null,
    ),
    SEL,
    { timeout: 30_000 },
  );
  await settle(page, 600);
}

/**
 * Tab from the readable-mode control into the canvas. This is the criterion's
 * own entry gesture — no scripted `focus()` — and it stops as soon as the
 * canvas is the active element.
 */
async function tabToCanvas(page: Page): Promise<void> {
  await page.locator(SEL.readableOverview).first().focus();
  for (let press = 0; press < 12; press += 1) {
    await page.keyboard.press('Tab');
    const onHost = await page.evaluate((sel) => (
      document.activeElement?.matches(sel.host) ?? false
    ), SEL);
    if (onHost) return;
  }
  const active = await page.evaluate(() => {
    const element = document.activeElement;
    return {
      tag: element?.tagName ?? null,
      attrs: element === null ? null : [...element.attributes].map((attribute) => `${attribute.name}=${attribute.value}`),
      text: element?.textContent?.slice(0, 80) ?? null,
    };
  });
  throw new Error(`Tab never reached the canvas: ${JSON.stringify(active)}`);
}

/** Press an arrow key and return the reading it produced. */
async function pressAndRead(page: Page, key: string): Promise<KeyboardReading> {
  await page.keyboard.press(key);
  await settle(page, 120);
  return readKeyboard(page);
}

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
        + '(the keyboard spec is listed in DEBUG_AGENT_SPEC_FILES)',
    );
  }
  const workspace = path.join(fixtureHome, ARCHITECTURE_FIXTURE_WORKSPACE);
  fixture = writeArchitectureFixture(workspace, { variant: 'quay-oo' });

  const bootstrap = await request.newContext({ baseURL });
  token = await createAccount(bootstrap);
  await bootstrap.dispose();

  const api = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  const userText =
    'Please review the keyboard navigation. '
    + `Start at ${fixture.seedIdentifiers.map((name) => `\`${name}\``).join(', ')}.`;
  sessionId = await armScenario(api, workspace, userText, fixture.seedIdentifiers[0]);
  await api.dispose();
  console.log(`[architecture-keyboard] fixture.entities=${fixture.entityTotal} session=${sessionId}`);
});

test('the canvas can be entered, walked, selected and multi-selected from the keyboard (1440x765)', async ({ browser }) => {
  const { context, page } = await openSignedInPage(browser, baseURL, token);
  try {
    await openClassDrawing(page, sessionId);

    // Enter with the canvas focused. Until then it is an image.
    await tabToCanvas(page);
    let reading = await readKeyboard(page);
    expect(reading.role, 'the focused canvas starts as role="img"').toBe('img');

    await page.keyboard.press('Enter');
    await settle(page, 200);
    reading = await readKeyboard(page);
    expect(reading.role, 'Enter turns the canvas into an application').toBe('application');
    expect(isCurrentEntityReadable(reading), `after Enter: ${JSON.stringify(reading)}`).toBe(true);
    expect(reading.label, 'the current entity must expose its name').not.toBeNull();
    expect(
      reading.announce.includes(reading.label ?? '\u0000'),
      `the live region must name the current entity: ${reading.announce}`,
    ).toBe(true);
    await shot(page, '01-entered-navigation');

    // Arrow keys walk at least two distinct entities; the ring stays inside the
    // canvas viewport, and the live region follows the cursor.
    const visited = new Set<string>([reading.entityId ?? '']);
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
      const next = await pressAndRead(page, key);
      expect(next.role, `${key} keeps the navigation state`).toBe('application');
      expect(next.activeDescendant, `${key} leaves an active descendant`).not.toBeNull();
      expect(next.entityId, `${key} must land on a drawn entity or frame`).not.toBeNull();
      if (next.entityId !== null) visited.add(next.entityId);
      if (!next.isFrame) {
        expect(
          next.announce.includes(next.label ?? '\u0000'),
          `${key}: the live region must name the entity it landed on (${next.announce})`,
        ).toBe(true);
      }
    }
    expect(visited.size, `arrows must traverse more than one entity (${[...visited].join(', ')})`).toBeGreaterThanOrEqual(2);
    reading = await readKeyboard(page);
    expect(reading.ring, 'the current entity must carry a focus ring').not.toBeNull();
    expect(reading.host, 'the canvas must have a box').not.toBeNull();
    const ring = reading.ring as Box;
    const host = reading.host as Box;
    expect(ring.width, 'the ring must be wider than nothing').toBeGreaterThan(0);
    expect(ring.x, 'the ring must be inside the canvas viewport on the left').toBeGreaterThanOrEqual(host.x - 1);
    expect(ring.y, 'the ring must be inside the canvas viewport on the top').toBeGreaterThanOrEqual(host.y - 1);
    expect(ring.right, 'the ring must be inside the canvas viewport on the right').toBeLessThanOrEqual(host.right + 1);
    expect(ring.bottom, 'the ring must be inside the canvas viewport on the bottom').toBeLessThanOrEqual(host.bottom + 1);
    await shot(page, '02-arrow-navigation');

    // Enter selects the current entity and opens the inspector.
    const selected = await readKeyboard(page);
    await page.keyboard.press('Enter');
    await expect(page.locator('[role="complementary"]'), 'Enter opens the inspector').toBeVisible({ timeout: 10_000 });
    await settle(page, 200);
    const afterSelect = await readKeyboard(page);
    expect(afterSelect.inspectorText, 'the inspector shows the selected entity').toContain(selected.label ?? '\u0000');
    await shot(page, '03-enter-selected');

    // Move away, then Shift+Enter adds the new entity to the tray.
    let toggled = selected;
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'ArrowRight']) {
      toggled = await pressAndRead(page, key);
      if (toggled.entityId !== null && toggled.entityId !== selected.entityId && !toggled.isFrame) break;
    }
    expect(toggled.entityId, 'the cursor must reach a different entity').not.toBe(selected.entityId);
    await page.keyboard.press('Shift+Enter');
    await settle(page, 200);
    const tally = await readKeyboard(page);
    expect(tally.trayPill, 'Shift+Enter must put the entity into the selection tray').not.toBeNull();
    expect(tally.trayPill ?? '', 'the tray must report two selected entities').toContain('2');
    await shot(page, '04-shift-enter-multiselect');

    // `A` pins through the context menu's own curation action and offers undo;
    // undoing restores the drawing (the DoD's pin-then-undo round trip).
    await page.keyboard.press('a');
    await expect(page.locator(SEL.toast), 'A must show the curation toast').toBeVisible({ timeout: 10_000 });
    expect((await page.locator(SEL.toast).textContent()) ?? '', 'the toast must say what happened').not.toBe('');
    await shot(page, '05-a-pinned-with-undo');
    await page.locator(SEL.undo).first().click();
    await expect(page.locator(SEL.toast), 'undo dismisses the pinned toast').toHaveCount(0, { timeout: 10_000 });
    // The click moved focus to the (now gone) undo button; the canvas keeps its
    // navigation state, so hand the keyboard back to it.
    await page.locator(SEL.host).focus();
    await settle(page, 200);

    // Control arm: remove the attribute the reading depends on; the SAME
    // predicate must land on the failing side, then back after a cursor move.
    const beforeDefect = await readKeyboard(page);
    expect(isCurrentEntityReadable(beforeDefect), 'control: the mechanism is green before injection').toBe(true);
    await page.evaluate((sel) => {
      document.querySelector(sel.host)?.removeAttribute('aria-activedescendant');
    }, SEL);
    const defect = await readKeyboard(page);
    expect(
      isCurrentEntityReadable(defect),
      'control: without the aria-activedescendant update the current entity is unreadable',
    ).toBe(false);
    // An arrow that changes the cursor re-renders the attribute from state.
    for (let attempt = 0; attempt < 6 && !isCurrentEntityReadable(await readKeyboard(page)); attempt += 1) {
      await page.keyboard.press(['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'][attempt % 4]);
      await settle(page, 120);
    }
    expect(
      isCurrentEntityReadable(await readKeyboard(page)),
      'control: moving the cursor restores the aria-activedescendant reading',
    ).toBe(true);

    // Escape leaves the navigation state and never reaches the page's own
    // Escape listener (the chat page owns that key for aborting a turn).
    const escapes: string[] = [];
    await page.exposeFunction('recordEscape', (value: string) => escapes.push(value));
    await page.evaluate(() => {
      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        (window as unknown as { recordEscape: (value: string) => void }).recordEscape('chat.abort');
      });
    });
    await page.keyboard.press('Escape');
    await settle(page, 150);
    reading = await readKeyboard(page);
    expect(reading.role, 'Escape returns the canvas to role="img"').toBe('img');
    expect(reading.activeDescendant, 'Escape clears the active descendant').toBeNull();
    expect(reading.ring, 'Escape removes the focus ring').toBeNull();
    expect(escapes, 'the canvas must stop Escape from reaching the chat page').toEqual([]);
    await shot(page, '06-escape-left-navigation');

    const elapsed = Date.now() - RUN_STARTED_AT;
    console.log(`[architecture-keyboard] elapsed=${elapsed}ms`);
    expect.soft(
      elapsed,
      `the criterion has to end inside the declared single-file budget; measured ${elapsed}ms`,
    ).toBeLessThan(120_000);
  } finally {
    await context.close();
  }
});
