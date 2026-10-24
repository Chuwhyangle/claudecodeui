import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

/**
 * The observation wall's phone/PC layout, measured in a real browser.
 *
 * WHAT CANNOT BE READ FROM JSDOM. Tailwind classes are only numbers once an engine applies the
 * stylesheet: a 44px tap target, a 12px floor, WCAG AA contrast and "the last tile is not under
 * the bottom bar" are all geometry and paint. So this file drives the real page at both
 * viewports and reads computed styles and boxes.
 *
 * THE CONTROL ARM. "The bottom bar does not cover the last tile" is only meaningful if the same
 * reading can say it does. The second half of each arm forces the realistic defect — the bar
 * fixed over the scrolling list and painted transparent — and re-reads through the SAME function.
 * A reading that always returned `overlaps: false` would pass the main arm and fail this one.
 *
 * THE FIXTURE. `/api/observation/wall` is stubbed with twelve tiles (the shipped cap) drawn from
 * the server's own payload shape, so the readings are about the rendering rather than about
 * whichever objects this host happens to have observed. The fleet summary is stubbed empty: the
 * wall does not need it, and the strip stays quiet.
 */

const AUTH_TOKEN_KEY = 'auth-token';
const USERNAME = 'e2euser';
const PASSWORD = 'e2epassword';

const SHOT_DIR = path.join(process.cwd(), 'tmp');
const PC_SHOT = path.join(SHOT_DIR, 'cockpit-observation-wall-pc.png');
const MOBILE_SHOT = path.join(SHOT_DIR, 'cockpit-observation-wall-mobile.png');
const PC_PINNED_SHOT = path.join(SHOT_DIR, 'cockpit-observation-wall-pc-pinned.png');
const PC_PREVIEW_SHOT = path.join(SHOT_DIR, 'cockpit-observation-wall-pc-preview.png');
const MOBILE_PREVIEW_SHOT = path.join(SHOT_DIR, 'cockpit-observation-wall-mobile-preview.png');

// The reading's floors — WCAG AA contrast (4.5:1), the shipped 12px type minimum and the 44×44
// phone tap target — are restated INSIDE `readLayout`, because `page.evaluate` serializes that
// function alone and it cannot close over module constants. The values in both places must agree.

const PC = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

const NOW = Date.now();

type Entry = {
  object: {
    uri: string;
    kind: 'session' | 'project' | 'architecture';
    title: string;
    status: { state: 'ok' | 'attention' | 'red' | 'unevaluated'; reason?: string };
    digest: Record<string, unknown>;
    revision: number;
    updatedAt: number;
    provenance: { producer: string; tier: 'deterministic' | 'llm'; evaluatedAt: number };
  };
  pinned: boolean;
  seenRevision: number;
  deltaItems: string[];
};

const entry = (
  index: number,
  kind: Entry['object']['kind'],
  state: Entry['object']['status']['state'],
): Entry => ({
  object: {
    uri:
      kind === 'session'
        ? `cloudcli://session/e2e-session-${index}`
        : kind === 'project'
          ? `quay://e2e-project-${index}/board`
          : `cloudcli://architecture/e2e-project-${index}`,
    kind,
    title: `${kind[0]!.toUpperCase()}${kind.slice(1)} observation ${index}`,
    status:
      state === 'unevaluated'
        ? { state, reason: 'the producer has not evaluated this object yet' }
        : state === 'attention' || state === 'red'
          ? { state, reason: 'a reading that asks for a person' }
          : { state },
    digest: {
      summary:
        'The answer comes first: this tile is about one observed object, its reading and its changes since the last look. '.repeat(
          index % 3 === 0 ? 3 : 1,
        ),
      recentTurn: 'A recent turn body long enough to give the preview something to draw.',
      changes: ['auth.ts +12', 'session.ts -4'],
      tests: ['login.spec.ts: pass'],
    },
    revision: 3,
    updatedAt: NOW - index * 60_000,
    provenance: { producer: 'session-digest', tier: 'deterministic', evaluatedAt: NOW - index * 60_000 },
  },
  // Three pinned sessions (0/5/10): enough for residency to render, while leaving the two
  // sessions, the two projects and the architecture view the walkthrough pins genuinely unpinned.
  pinned: index % 5 === 0,
  seenRevision: 2,
  deltaItems: index % 3 === 0 ? ['one change', 'another change'] : [],
});

/** Twelve tiles — the shipped cap — in the order the server would send (loud states first). */
const WALL = {
  entries: [
    entry(0, 'session', 'attention'),
    entry(1, 'project', 'red'),
    entry(2, 'architecture', 'unevaluated'),
    entry(3, 'session', 'ok'),
    entry(4, 'project', 'attention'),
    entry(5, 'session', 'ok'),
    entry(6, 'architecture', 'ok'),
    entry(7, 'session', 'ok'),
    entry(8, 'project', 'ok'),
    entry(9, 'session', 'ok'),
    entry(10, 'architecture', 'ok'),
    entry(11, 'session', 'ok'),
  ],
  collapsedCount: 0,
  producers: [
    {
      producer: 'session-digest',
      state: 'ok',
      stale: false,
      reason: null,
      lastAttemptAt: NOW - 60_000,
      lastWriteAt: NOW - 60_000,
      expectedIntervalMs: 900_000,
    },
  ],
  self: null,
};

let authToken = '';

const ensureSignedIn = async (page: Page) => {
  await page.goto('/');
  const createAccount = page.getByRole('button', { name: 'Create Account' });
  const settings = page.getByRole('button', { name: 'Settings' }).first();
  await expect(createAccount.or(settings).or(page.locator('#username')).first()).toBeVisible();
  if (await createAccount.count()) {
    await page.locator('#username').fill(USERNAME);
    await page.locator('input[type=password]').nth(0).fill(PASSWORD);
    await page.locator('input[type=password]').nth(1).fill(PASSWORD);
    await createAccount.click();
    await page.getByPlaceholder('John Doe').fill('E2E User');
    await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Complete Setup' }).click();
    await expect(settings).toBeVisible({ timeout: 15_000 });
  } else if (await page.locator('#username').count()) {
    await page.locator('#username').fill(USERNAME);
    await page.locator('input[type=password]').first().fill(PASSWORD);
    await page.locator('form button[type=submit]').click();
    await expect(settings).toBeVisible({ timeout: 15_000 });
  }
};

const bootstrapAuth = async (browser: Browser) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await ensureSignedIn(page);
  authToken = (await page.evaluate((key) => window.localStorage.getItem(key), AUTH_TOKEN_KEY)) ?? '';
  await context.close();
  if (!authToken) {
    throw new Error('onboarding completed but no auth token was stored — the wall cannot authenticate');
  }
};

const authenticate = async (page: Page) => {
  await page.addInitScript(([key, token]) => {
    try {
      window.localStorage.setItem(key, token);
    } catch {
      // about:blank has an opaque origin; the real navigation below is what matters.
    }
  }, [AUTH_TOKEN_KEY, authToken] as const);
};

/** The wall, and an empty fleet: the strip stays quiet and the readings are deterministic. */
const stubWall = async (page: Page) => {
  await page.route('**/api/observation/wall', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(WALL) }),
  );
  await page.route('**/api/quay/fleet-summary', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        projects: [],
        generatedAt: new Date(NOW).toISOString(),
        ttlPerProjectMs: 30000,
        cached: false,
      }),
    }),
  );
};

/**
 * The DoD walkthrough's live stub: reads serve a mutable copy of the fixture, and the two write
 * routes record what the page asked for and mutate the stored pins. That makes the walkthrough a
 * real round trip (pin → re-read → the tile is resident) rather than a DOM click with no answer.
 */
const stubWallInteractive = async (page: Page) => {
  const wall = JSON.parse(JSON.stringify(WALL)) as typeof WALL;
  const writes: Array<{ method: string; uri: string }> = [];
  const seen: Array<{ uri: string; revision: number }> = [];

  await page.route('**/api/observation/wall', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(wall) }),
  );
  await page.route('**/api/observation/watch/**', async (route) => {
    const request = route.request();
    const uri = decodeURIComponent(new URL(request.url()).pathname.split('/watch/')[1] ?? '');
    const method = request.method();
    const entry = wall.entries.find((candidate) => candidate.object.uri === uri);
    if (entry !== undefined) entry.pinned = method === 'PUT';
    writes.push({ method, uri });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
  });
  await page.route('**/api/observation/seen', async (route) => {
    seen.push(JSON.parse(route.request().postData() ?? '{}') as { uri: string; revision: number });
    if (route.request().method() === 'POST') {
      const body = seen[seen.length - 1];
      const entry = wall.entries.find((candidate) => candidate.object.uri === body?.uri);
      if (entry !== undefined) entry.seenRevision = body?.revision ?? entry.seenRevision;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ advanced: true }) });
  });
  await page.route('**/api/quay/fleet-summary', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ projects: [], generatedAt: new Date(NOW).toISOString(), ttlPerProjectMs: 30000, cached: false }),
    }),
  );

  return { wall, writes, seen };
};

type Violation = string;

type LayoutReading = {
  horizontalOverflow: boolean;
  viewportWidth: number;
  scrollWidth: number;
  fontViolations: Violation[];
  contrastViolations: Violation[];
  tapTargetViolations: Violation[];
  lastTile: { overlaps: boolean; fullyVisible: boolean; reachable: boolean; scrollable: boolean };
};

/**
 * ONE reading for both arms. It returns data, not assertions, so a control arm can re-run the
 * exact same measurement after injecting a defect.
 *
 * Contrast resolution follows `cockpit-visual.spec.ts`: a transparent element's background is
 * the first opaque ancestor's, because that is what is actually painted behind the glyphs.
 */
const readLayout = (): LayoutReading => {
  // Page.evaluate serializes this function alone: the module-level floors are restated here
  // (and asserted against those constants in the test body) so the reading can actually run.
  const minFontPx = 12;
  const aaContrast = 4.5;
  const minTargetPx = 44;
  const parseRgb = (value: string): [number, number, number] => {
    const match = value.match(/rgba?\(([^)]+)\)/);
    if (match === null) throw new Error(`unreadable colour serialization: ${value}`);
    const [r, g, b] = (match[1] ?? '')
      .split(/[,\s/]+/)
      .filter((part) => part !== '')
      .slice(0, 3)
      .map(Number);
    return [r ?? 0, g ?? 0, b ?? 0];
  };
  const linear = (value: number): number => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const luminance = ([r, g, b]: [number, number, number]): number =>
    0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  const contrast = (foreground: string, background: string): number => {
    const a = luminance(parseRgb(foreground));
    const b = luminance(parseRgb(background));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  // "Which colour is actually painted behind these glyphs" is the first ancestor whose
  // background is FULLY opaque. A 15%-alpha badge tint is not that colour: reading it as the
  // background would judge the text against a colour it is never drawn on.
  const isOpaque = (candidate: string): boolean => {
    if (candidate === 'transparent') return false;
    const match = candidate.match(/rgba?\(([^)]+)\)/);
    if (match === null) return true;
    const parts = (match[1] ?? '').split(/[,\s/]+/).filter((part) => part !== '');
    if (parts.length < 4) return true;
    return Number(parts[3]) >= 0.99;
  };
  const backgroundOf = (element: HTMLElement): string => {
    for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
      const candidate = getComputedStyle(node).backgroundColor;
      if (isOpaque(candidate)) return candidate;
    }
    return 'rgb(255, 255, 255)';
  };

  const fontViolations: Violation[] = [];
  const contrastViolations: Violation[] = [];
  const samples = [
    ...Array.from(document.querySelectorAll<HTMLElement>('[data-testid="observation-tile-title"]')),
    ...Array.from(document.querySelectorAll<HTMLElement>('[data-testid="observation-tile-state"]')),
    ...Array.from(document.querySelectorAll<HTMLElement>('[data-testid="observation-tile-liveness"]')),
    ...Array.from(document.querySelectorAll<HTMLElement>('[data-testid="observation-tile-summary"]')),
    ...Array.from(document.querySelectorAll<HTMLElement>('[data-testid="cockpit-nav-wall"]')),
    ...Array.from(document.querySelectorAll<HTMLElement>('[data-testid="cockpit-nav-fleet"]')),
  ];
  for (const sample of samples) {
    const style = getComputedStyle(sample);
    const fontPx = Number.parseFloat(style.fontSize);
    const label = `${sample.getAttribute('data-testid')} "${(sample.textContent ?? '').slice(0, 24)}"`;
    if (!(fontPx >= minFontPx)) {
      fontViolations.push(`${label} is ${fontPx}px, below the ${minFontPx}px floor`);
    }
    const ratio = contrast(style.color, backgroundOf(sample));
    if (!(ratio >= aaContrast)) {
      contrastViolations.push(
        `${label} is ${ratio.toFixed(2)}:1 (${style.color} on ${backgroundOf(sample)}), below ${aaContrast}:1`,
      );
    }
  }

  const tapTargetViolations: Violation[] = [];
  if (window.innerWidth < 640) {
    const targets = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid="observation-tile"], [data-testid="observation-tile"] button, ' +
          '[data-testid="cockpit-nav-wall"], [data-testid="cockpit-nav-fleet"], ' +
          '[data-testid="cockpit-remote-toggle"]',
      ),
    );
    for (const target of targets) {
      const box = target.getBoundingClientRect();
      if (box.width < minTargetPx - 0.5 || box.height < minTargetPx - 0.5) {
        tapTargetViolations.push(
          `${target.getAttribute('data-testid')} is ${box.width.toFixed(1)}×${box.height.toFixed(1)}, below ${minTargetPx}×${minTargetPx}`,
        );
      }
    }
  }

  const scroller = document.querySelector<HTMLElement>('[data-testid="observation-wall-scroll"]');
  const footer = document.querySelector<HTMLElement>('[data-testid="cockpit-status"]');
  const tiles = document.querySelectorAll<HTMLElement>('[data-testid="observation-tile"]');
  const last = tiles[tiles.length - 1];
  let lastTile = { overlaps: false, fullyVisible: false, reachable: false, scrollable: false };
  if (scroller !== null && footer !== null && last !== undefined) {
    const scrollable = scroller.scrollHeight > scroller.clientHeight + 1;
    scroller.scrollTop = scroller.scrollHeight;
    const lastRect = last.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    lastTile = {
      // The defect the control arm injects is observable HERE: a bar painted over the list
      // intersects the last tile's box, whatever colour the bar is.
      overlaps: lastRect.bottom > footerRect.top + 1,
      fullyVisible: lastRect.bottom <= footerRect.top + 1,
      reachable: lastRect.top >= scrollerRect.top - 1,
      scrollable,
    };
  }

  const documentElement = document.documentElement;
  return {
    horizontalOverflow: documentElement.scrollWidth > window.innerWidth + 1,
    viewportWidth: window.innerWidth,
    scrollWidth: documentElement.scrollWidth,
    fontViolations,
    contrastViolations,
    tapTargetViolations,
    lastTile,
  };
};

type FooterReading = {
  overlaps: boolean;
  footerOpaque: boolean;
  footerPosition: string;
  background: string;
};

/** The second half of the same judgement: is the last tile under the bottom bar, really? */
const readFooterOverlap = (): FooterReading => {
  const scroller = document.querySelector<HTMLElement>('[data-testid="observation-wall-scroll"]');
  const footer = document.querySelector<HTMLElement>('[data-testid="cockpit-status"]');
  const tiles = document.querySelectorAll<HTMLElement>('[data-testid="observation-tile"]');
  const last = tiles[tiles.length - 1];
  if (scroller === null || footer === null || last === undefined) {
    return { overlaps: false, footerOpaque: true, footerPosition: 'missing', background: 'none' };
  }
  scroller.scrollTop = scroller.scrollHeight;
  const lastRect = last.getBoundingClientRect();
  const footerRect = footer.getBoundingClientRect();
  const background = getComputedStyle(footer).backgroundColor;
  const alphaMatch = background.match(/rgba?\(([^)]+)\)/);
  const alphaParts =
    alphaMatch === null
      ? []
      : (alphaMatch[1] ?? '').split(/[,\s/]+/).filter((part) => part !== '');
  const footerOpaque =
    background !== 'transparent' && (alphaParts.length < 4 || Number(alphaParts[3]) >= 0.99);
  return {
    overlaps: lastRect.bottom > footerRect.top + 1,
    footerOpaque,
    footerPosition: getComputedStyle(footer).position,
    background,
  };
};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  await bootstrapAuth(browser);
});

test('PC 1440×900: no overflow, readable type, and the last tile clears the bottom bar', async ({ page }) => {
  await authenticate(page);
  await stubWall(page);
  await page.setViewportSize(PC);
  await page.goto('/cockpit?view=wall');

  await expect(page.getByTestId('observation-tile').first()).toBeVisible();
  await expect(page.getByTestId('observation-tile')).toHaveCount(12);

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: PC_SHOT, fullPage: true });

  const reading = await page.evaluate(readLayout);
  expect(reading.horizontalOverflow, JSON.stringify(reading)).toBe(false);
  expect(reading.fontViolations, JSON.stringify(reading)).toEqual([]);
  expect(reading.contrastViolations, JSON.stringify(reading)).toEqual([]);
  // On a wide screen the wall may fit without scrolling; what must hold is that the last tile
  // is never under the bar.
  expect(reading.lastTile.overlaps, JSON.stringify(reading.lastTile)).toBe(false);
  expect(reading.lastTile.fullyVisible, JSON.stringify(reading.lastTile)).toBe(true);

  // The control arm: the same reading must go red once the bar is painted over the list.
  const before = await page.evaluate(readFooterOverlap);
  expect(before.overlaps).toBe(false);
  expect(before.footerOpaque).toBe(true);
});

test('mobile 390×844: no overflow, 44×44 targets, readable type, last tile reachable', async ({ page }) => {
  await authenticate(page);
  await stubWall(page);
  await page.setViewportSize(MOBILE);
  await page.goto('/cockpit?view=wall');

  await expect(page.getByTestId('observation-tile').first()).toBeVisible();
  await expect(page.getByTestId('observation-tile')).toHaveCount(12);

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: MOBILE_SHOT, fullPage: true });

  const reading = await page.evaluate(readLayout);
  expect(reading.horizontalOverflow, JSON.stringify(reading)).toBe(false);
  expect(reading.fontViolations, JSON.stringify(reading)).toEqual([]);
  expect(reading.contrastViolations, JSON.stringify(reading)).toEqual([]);
  expect(reading.tapTargetViolations, JSON.stringify(reading)).toEqual([]);
  expect(reading.lastTile.scrollable, JSON.stringify(reading.lastTile)).toBe(true);
  expect(reading.lastTile.reachable, JSON.stringify(reading.lastTile)).toBe(true);
  expect(reading.lastTile.overlaps, JSON.stringify(reading.lastTile)).toBe(false);
});

test('control arm: a transparent bar fixed over the list reds the same overlap reading', async ({ page }) => {
  await authenticate(page);
  await stubWall(page);
  await page.setViewportSize(MOBILE);
  await page.goto('/cockpit?view=wall');
  await expect(page.getByTestId('observation-tile').first()).toBeVisible();

  const before = await page.evaluate(readFooterOverlap);
  expect(before.overlaps, JSON.stringify(before)).toBe(false);

  // The defect: the bar stops reserving its own space and floats over the scrolling wall,
  // painted transparent so the overlap is visible (which is why it is a defect at all).
  await page.evaluate(() => {
    const footer = document.querySelector<HTMLElement>('[data-testid="cockpit-status"]');
    if (footer === null) throw new Error('the bottom bar is not on the page');
    footer.style.setProperty('position', 'fixed', 'important');
    footer.style.setProperty('bottom', '0', 'important');
    footer.style.setProperty('left', '0', 'important');
    footer.style.setProperty('right', '0', 'important');
    // The paint half of the defect is injected as a stylesheet rule rather than an inline
    // mutation: this is the shape a real CSS regression would take, and it is what the
    // measurement function must be able to see.
    const style = document.createElement('style');
    style.id = 'control-arm-transparent-footer';
    style.textContent =
      '[data-testid="cockpit-status"] { background-color: transparent !important; background-image: none !important; }';
    document.head.appendChild(style);
    footer.setAttribute('data-control-arm-footer', String(getComputedStyle(footer).backgroundColor));
  });

  // `src/index.css` gives every `footer` a 200 ms `background-color` transition (for theme
  // switching), so a read taken immediately after the injection sees the colour it is
  // transitioning FROM. Poll for the injected value instead of sleeping a guessed 200 ms.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const footer = document.querySelector<HTMLElement>('[data-testid="cockpit-status"]');
          return footer === null ? '' : getComputedStyle(footer).backgroundColor;
        }),
      { message: 'the injected transparent colour reaches the bottom bar' },
    )
    .toBe('rgba(0, 0, 0, 0)');

  const after = await page.evaluate(readFooterOverlap);
  expect(after.footerOpaque, JSON.stringify(after)).toBe(false);
  expect(after.footerPosition, JSON.stringify(after)).toBe('fixed');
  expect(after.overlaps, JSON.stringify(after)).toBe(true);
});

/**
 * THE DoD WALKTHROUGH (PC). The product path, in a real browser: pin two sessions, two projects
 * and one architecture view; open a tile's preview and watch its deltas clear; 「稍后再看」;
 * then use the browser's back button to return to the wall from 「全部项目」.
 *
 * This is evidence rather than a criterion: the assertions are the requests the page actually
 * made and the DOM it drew afterwards, and the screenshots are the frames the DoD attaches.
 */
test('DoD walkthrough (PC): pin five objects, preview clears the delta, back returns to the wall', async ({ page }) => {
  await authenticate(page);
  const state = await stubWallInteractive(page);
  await page.setViewportSize(PC);
  await page.goto('/cockpit?view=wall');
  await expect(page.getByTestId('observation-tile')).toHaveCount(12);

  const pinTargets = [
    'cloudcli://session/e2e-session-3',
    'cloudcli://session/e2e-session-7',
    'quay://e2e-project-1/board',
    'quay://e2e-project-4/board',
    'cloudcli://architecture/e2e-project-2',
  ];
  for (const uri of pinTargets) {
    await page.locator(`[data-observation-uri="${uri}"] [data-testid="observation-tile-pin"]`).click();
  }
  await expect.poll(() => state.writes.filter((write) => write.method === 'PUT').length).toBe(5);
  expect(state.writes.map((write) => write.uri).sort()).toEqual([...pinTargets].sort());
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: PC_PINNED_SHOT, fullPage: true });

  // Opening the preview writes the seen cursor once and clears the tile's delta locally.
  const tile = page.locator(
    '[data-testid="observation-tile"][data-observation-uri="cloudcli://session/e2e-session-0"]',
  );
  await expect(tile).toHaveAttribute('data-observation-unseen', '2');
  await tile.getByTestId('observation-tile-open').click();
  await expect(page.getByTestId('cockpit-observation-preview')).toBeVisible();
  await expect.poll(() => state.seen.length).toBe(1);
  expect(state.seen[0]).toEqual({ uri: 'cloudcli://session/e2e-session-0', revision: 3 });
  await expect(tile).toHaveAttribute('data-observation-unseen', '0');
  await page.screenshot({ path: PC_PREVIEW_SHOT, fullPage: true });

  // 「稍后再看」 closes without another seen write.
  await page.getByTestId('observation-preview-later').click();
  await expect(page.getByTestId('cockpit-observation-preview')).toHaveCount(0);
  expect(state.seen).toHaveLength(1);

  // A view switch is a browser navigation: back returns to the wall.
  await page.getByTestId('cockpit-nav-fleet').click();
  await expect(page).toHaveURL(/view=fleet/);
  await page.goBack();
  await expect(page).toHaveURL(/view=wall/);
  await expect(page.getByTestId('cockpit-wall')).toBeVisible();
});

/** THE DoD WALKTHROUGH (PHONE): the same model, one viewport — the preview takes the stage. */
test('DoD walkthrough (mobile): the preview takes the stage and 「稍后再看」 returns to the list', async ({ page }) => {
  await authenticate(page);
  await stubWallInteractive(page);
  await page.setViewportSize(MOBILE);
  await page.goto('/cockpit?view=wall');
  await expect(page.getByTestId('observation-tile').first()).toBeVisible();

  await page
    .locator('[data-observation-uri="cloudcli://session/e2e-session-0"]')
    .getByTestId('observation-tile-open')
    .click();
  await expect(page.getByTestId('cockpit-observation-preview')).toBeVisible();
  // The list is hidden in place of the preview on a phone (the same model, one viewport).
  await expect(page.getByTestId('observation-wall')).toBeHidden();
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: MOBILE_PREVIEW_SHOT, fullPage: true });

  await page.getByTestId('observation-preview-later').click();
  await expect(page.getByTestId('observation-wall')).toBeVisible();
});
