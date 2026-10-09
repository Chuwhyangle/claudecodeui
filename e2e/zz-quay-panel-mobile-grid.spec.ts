/**
 * The Quay panel's two responsive grids on a phone: a long task title must be ellipsised inside
 * the viewport, not stretch the grid track past it.
 *
 * The defect this file is the permanent reading of. Both grids on `QuayPanel` were written as
 * `grid gap-4 md:grid-cols-2` with no base column count. Below `md` Tailwind therefore emits no
 * `grid-template-columns` at all, and an implicit grid track has no `minmax(0, 1fr)` floor: its
 * minimum width falls back to the content's min-content width. A detail row's title is
 * `truncate`d (`white-space: nowrap`), so on a 390px phone a long Chinese task title set the
 * track to ~2943px, the grid overflowed the `overflow-hidden` Quay view, and the text was
 * hard-clipped at the screen edge with nothing to scroll.
 *
 * Why the reading has to happen in a real browser. jsdom does not compute CSS grid track sizes,
 * so a rendered unit test measures nothing here — it renders the same DOM for a correct and a
 * broken grid. The class-level guard that the base column count is present lives in
 * `src/modules/quay/tests/QuayPanel.test.tsx`; this file is the geometric one. The two are
 * deliberately separate: the class guard survives where a browser cannot run, and this reading
 * is the one that can see the track actually stay inside the viewport.
 *
 * The fixture. The project has to (a) be a directory the app discovered as a project and (b)
 * carry a `.quay/config.yml`, so the Quay tab appears and its Tier-2 snapshot is fetched. It is
 * seeded from this file rather than `playwright.config.ts` because this task's write surface is
 * exactly `QuayPanel.tsx`, its unit test and this spec — the seed is therefore written before
 * the page is navigated, and the spec waits for the project to appear in `GET /api/projects`
 * (which runs the synchronizer) before it touches the browser. The provider entry in the
 * fixture's config is copied verbatim out of the repository's own `.quay/config.yml`, so the
 * plugin path is never restated here and cannot drift with the plugin version.
 *
 * One task in the fixture's task directory, with a title deliberately long enough to reproduce
 * the reported ~2943px track. The assertion is not the exact number — it is that the recent-tasks
 * list, its sibling grid block and the nearest scrolling ancestor all stay within the viewport,
 * which the pre-fix build fails by a factor of seven and the fixed one passes.
 */

import fs from 'node:fs';
import path from 'node:path';

import { expect, request, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

const CLIENT_URL = `http://127.0.0.1:${process.env.QUAY_E2E_CLIENT_PORT}`;
const DATA_DIR = process.env.QUAY_E2E_DATA_DIR ?? '';
/** The repository checkout this spec is running from; the fixture reuses its quay provider wiring. */
const REPO_ROOT = path.resolve(process.cwd());

/** The 390×844 phone viewport the defect was reported at. */
const VIEWPORT = { width: 390, height: 844 };
/** The desktop viewport the same document is widened to, so the two-column layout is read too. */
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
/**
 * How far past the viewport a box may sit and still count as inside it.
 *
 * A classic scrollbar is not part of `getBoundingClientRect`, and a sub-pixel layout pass can
 * round a `clientWidth` down by a hair; one pixel absorbs both without hiding an overflow, which
 * at the pre-fix reading is ~2553px.
 */
const TOLERANCE_PX = 1;

/** The fixture project, its one session and its one deliberately long task. */
const WORKSPACE = path.join(DATA_DIR, 'quay-panel-grid-workspace');
const SESSION_ID = 'e2e-quay-panel-grid';
const SESSION_NAME = 'quay-panel-grid';
/** The fixture workspace's basename — the sidebar's display name for the project. */
const WORKSPACE_NAME = path.basename(WORKSPACE);
const TASK_ID = 'fixture-grid-blowout-long-title';
const LONG_TITLE =
  '这是一个用于复现 Quay 面板网格溢出的非常长的中文任务标题它足够长以至于在 390 像素的手机视口下会把隐式网格轨道撑到视口之外';
/**
 * A second fixture task whose *id*, not its title, is the long value — a real task slug measured
 * in this repository's own `.quay` store (`gap-warmclientstartup-returns-on-one-dep-200-not-
 * optimizer-quiescence`, 71 characters), not a synthetic worst case. `DetailList`'s id span used
 * to be `shrink-0` with no `truncate`/`min-w-0`, so this id alone (font-mono, no wrap) measured
 * wider than a 390px phone and pushed `quay-panel-loaded`'s `scrollWidth` past the viewport — a
 * distinct overflow from the grid-track blowout above (that one needs a long *title* and is fixed
 * by `grid-cols-1` alone; this one needs a long *id* and was never exercised by this file before).
 * Written before the long-title task so the long-title task's later mtime keeps it the newest
 * (first) row — the existing `recentTasksTitle` premise check above is unaffected by this addition.
 */
const LONG_ID_TASK_ID = 'gap-warmclientstartup-returns-on-one-dep-200-not-optimizer-quiescence';
const LONG_ID_TASK_TITLE = 'Short title, long id';

const AUTH_TOKEN_KEY = 'auth-token';
const USERNAME = 'e2euser';
const PASSWORD = 'e2epassword';

/**
 * Writes the fixture project, its quay config and the transcript that makes the app discover it.
 *
 * Called before the first navigation. `GET /api/projects` runs the session synchronizer, and the
 * wait below drives that call until this project is in the listing, so the transcript is indexed
 * deterministically rather than racing the boot-time scan or the file watcher.
 */
const seedFixtureProject = (): void => {
  const tasksDir = path.join(WORKSPACE, 'tasks');
  const goalDir = path.join(WORKSPACE, 'goals');
  const adrDir = path.join(WORKSPACE, 'adr');
  const metaDir = path.join(WORKSPACE, 'meta');
  for (const dir of [path.join(WORKSPACE, '.quay'), tasksDir, goalDir, adrDir, metaDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // The repository's own `.quay/config.yml` carries no literal `mcp_entry` any more — the
  // native provider now derives it from the `.quay/plugin` symlink (quay >= 0.17.0: an entry
  // missing `mcp_entry` resolves it from that symlink's `dist/quay-native.js`, rather than
  // requiring a project to restate the vendored runtime path). This file previously copied an
  // `mcp_entry:` line out of the repo's config with a regex, which the schema change left
  // matching nothing (`REPO_QUAY_CONFIG` has no such line to find — read-fix, not a change in
  // what the fixture needs). The fixture now mirrors the repo's own, currently-working wiring
  // instead: point `.quay/plugin` at the same installed plugin the repo checkout points to, and
  // omit `mcp_entry` so the native provider derives it the same way the real project does.
  const repoPluginTarget = fs.realpathSync(path.join(REPO_ROOT, '.quay', 'plugin'));
  fs.symlinkSync(repoPluginTarget, path.join(WORKSPACE, '.quay', 'plugin'));

  fs.writeFileSync(
    path.join(WORKSPACE, '.quay', 'config.yml'),
    [
      'providers:',
      '  native:',
      '    enabled: true',
      `    tasks_dir: "${tasksDir}"`,
      '    env:',
      `      QUAY_NATIVE_TASKS_DIR: "${tasksDir}"`,
      `      QUAY_NATIVE_GOAL_DIR: "${goalDir}"`,
      `      QUAY_NATIVE_ADR_DIR: "${adrDir}"`,
      `      QUAY_NATIVE_META_DIR: "${metaDir}"`,
      'loop:',
      `  repo_root: ${WORKSPACE}`,
      '  fork_baseline: develop',
      '',
    ].join('\n'),
    'utf8',
  );

  // Written first so its mtime is older than the long-title task below, keeping the long-title
  // task the newest (first) "Recent tasks" row — see the constant's own comment.
  fs.writeFileSync(
    path.join(tasksDir, `${LONG_ID_TASK_ID}.md`),
    [
      '---',
      `id: ${LONG_ID_TASK_ID}`,
      `title: ${LONG_ID_TASK_TITLE}`,
      'status: ready',
      '---',
      'A fixture task whose id (not its title) is long enough to overflow the id span.',
      '',
    ].join('\n'),
    'utf8',
  );

  fs.writeFileSync(
    path.join(tasksDir, `${TASK_ID}.md`),
    [
      '---',
      `id: ${TASK_ID}`,
      `title: ${LONG_TITLE}`,
      'status: ready',
      '---',
      'A fixture task whose title is long enough to stretch an unbounded grid track.',
      '',
    ].join('\n'),
    'utf8',
  );

  const transcriptDir = path.join(DATA_DIR, '.claude', 'projects', 'quay-panel-grid-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const records = [
    {
      type: 'user',
      sessionId: SESSION_ID,
      cwd: WORKSPACE,
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'open the quay panel for the mobile grid reading' }] },
    },
    { type: 'custom-title', sessionId: SESSION_ID, cwd: WORKSPACE, timestamp, customTitle: SESSION_NAME },
  ];
  fs.writeFileSync(
    path.join(transcriptDir, `${SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

/** An account this run owns, created over the API. */
async function createAccount(api: APIRequestContext): Promise<string> {
  const register = await api.post('/api/auth/register', { data: { username: USERNAME, password: PASSWORD } });
  const registered = await register.json().catch(() => null);
  if (typeof registered?.token === 'string') {
    await api.post('/api/user/complete-onboarding', { headers: { Authorization: `Bearer ${registered.token}` } });
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

/** The project listing row whose path is the fixture workspace, or null while it is not indexed yet. */
const fixtureProjectRow = async (api: APIRequestContext): Promise<{ projectId: string; hasQuayConfig: boolean } | null> => {
  const response = await api.get('/api/projects');
  if (!response.ok()) return null;
  const projects = (await response.json()) as { projectId: string; fullPath?: string; path?: string; hasQuayConfig?: boolean }[];
  const row = projects.find((project) => (project.fullPath ?? project.path) === WORKSPACE);
  return row ? { projectId: row.projectId, hasQuayConfig: Boolean(row.hasQuayConfig) } : null;
};

/**
 * Drives `GET /api/projects` — which runs the synchronizer — until the fixture is in the listing.
 *
 * The premise it establishes is the whole reason the page below can be read: a project the app has
 * not indexed offers no Quay tab. A `hasQuayConfig:false` row is a hard fail rather than something
 * to wait out, because no amount of waiting writes a `.quay/config.yml`.
 */
const waitForFixtureProject = async (api: APIRequestContext, budgetMs = 30_000): Promise<void> => {
  const deadline = Date.now() + budgetMs;
  let last = 'never asked';
  while (Date.now() < deadline) {
    const row = await fixtureProjectRow(api);
    if (row) {
      if (!row.hasQuayConfig) {
        throw new Error(`the fixture project was indexed without a quay config at ${WORKSPACE}`);
      }
      return;
    }
    last = `GET /api/projects listed no project at ${WORKSPACE}`;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the fixture project never appeared after ${budgetMs}ms: ${last}`);
};

/**
 * Navigates to the app root and opens the compact sidebar, surviving a first paint that is
 * pulled out from under the navigation.
 *
 * The app's Vite client reloads the document when its dependency optimizer commits
 * (`504 Outdated Optimize Dep`), and a locator left waiting across that reload waits on a document
 * that no longer exists — the cell then dies on its timeout with nothing to read. So the wait is
 * bounded into probes with a bounded number of reloads, and a menu button still absent afterwards
 * is reported as itself rather than as a silent timeout.
 */
const openRootSidebar = async (page: Page): Promise<void> => {
  const menu = page.getByRole('button', { name: 'Open menu' });
  const appears = (timeoutMs: number) =>
    menu.first().waitFor({ state: 'visible', timeout: timeoutMs }).then(() => true, () => false);
  await page.goto('/');
  let up = await appears(10_000);
  for (let attempt = 0; !up && attempt < 2; attempt += 1) {
    await page.reload().catch(() => undefined);
    up = await appears(6_000);
  }
  expect(
    up,
    'the mobile header menu button must render — the client never came up to a document that stays',
  ).toBe(true);
  await menu.first().click();
};

/* ── the reading ─────────────────────────────────────────────────────────────── */

type GridBlock = { label: string; width: number };
type GridReading = {
  /** The `h3` of the first section in the grid; the grid is named after the block being read. */
  name: string;
  /** The grid container's own columns, printed because it is the defect's signature. */
  templateColumns: string;
  /** How many explicit tracks the grid resolved to. Two at `md` and up, one below it. */
  trackCount: number;
  blocks: GridBlock[];
};
type Reading = {
  innerWidth: number;
  /**
   * The grid read from its `Task ledger` heading — the same single `md:grid-cols-2` grid as
   * `detailGrid` below (a later task folded the panel's two responsive grids into one; see the
   * unit guard `QuayPanel.test.tsx` that now asserts there is exactly one). Reading it from a
   * second, independent heading keeps this file's original two-grid regression coverage: a track
   * count/width check that only ever queried one heading would miss a regression specific to
   * content elsewhere in the same grid.
   */
  statusGrid: GridReading | null;
  /** The `Recent tasks` / `ADRs` grid — the one the reported overflow came from. */
  detailGrid: GridReading | null;
  recentTasksWidth: number | null;
  /** The title actually rendered in the first recent-tasks row, so the premise is a reading too. */
  recentTasksTitle: string | null;
  /** The nearest ancestor that scrolls or hides its overflow: the box the text is clipped by. */
  scroller: { kind: string; clientWidth: number; scrollWidth: number } | null;
};

/**
 * One reading of everything the assertions below rest on, taken in a single evaluate so the
 * numbers describe one instant.
 *
 * Both of the panel's `md:grid-cols-2` grids are read, found by the heading of their first
 * section rather than by a class or position: the fix has to hold for both, and a query that
 * silently matched only one would let the other regress unnoticed.
 *
 * The nearest scrolling ancestor is found by walking up from the recent-tasks list, not by
 * naming a selector: the fix must hold for whichever container happens to clip the panel, and a
 * hardcoded ancestor would keep passing if the clipping moved to a new one.
 */
const readPanel = (page: Page): Promise<Reading> =>
  page.evaluate(() => {
    const round = (value: number) => Math.round(value * 100) / 100;
    const widthOf = (element: Element | null) => (element ? round(element.getBoundingClientRect().width) : null);

    const readGrid = (headingText: string) => {
      const heading = [...document.querySelectorAll('h3')].find(
        (candidate) => (candidate.textContent ?? '').trim() === headingText,
      );
      // Walk up to the nearest actual grid container rather than assuming a fixed number of
      // hops: `Recent tasks` is nested one level deeper than `Task ledger` (its `DetailList`
      // section sits inside `Task ledger`'s own section's `div.mt-3`), so a hardcoded
      // `.closest('section')?.parentElement` silently resolves to a non-grid `div` for one
      // heading but not the other. Walking by `display: grid` holds regardless of nesting depth.
      let grid: Element | null = heading?.parentElement ?? null;
      while (grid && getComputedStyle(grid).display !== 'grid') {
        grid = grid.parentElement;
      }
      if (!grid) return null;
      const templateColumns = getComputedStyle(grid).gridTemplateColumns;
      return {
        name: headingText,
        templateColumns,
        trackCount: templateColumns.split(/\s+/).filter(Boolean).length,
        blocks: [...grid.children].map((element) => ({
          label: (element.querySelector('h3')?.textContent ?? element.tagName).trim(),
          width: round(element.getBoundingClientRect().width),
        })),
      };
    };

    const recentTasks = document.querySelector('[data-testid="quay-panel-recent-tasks"]');

    let node: Element | null = recentTasks?.parentElement ?? null;
    let scroller: Reading['scroller'] = null;
    while (node) {
      const style = getComputedStyle(node);
      const clips = [style.overflowX, style.overflowY].some(
        (value) => value === 'hidden' || value === 'auto' || value === 'scroll',
      );
      if (clips) {
        scroller = {
          kind:
            node.getAttribute('data-testid')
            ?? node.getAttribute('data-workspace-view')
            ?? node.tagName.toLowerCase(),
          clientWidth: node.clientWidth,
          scrollWidth: node.scrollWidth,
        };
        break;
      }
      node = node.parentElement;
    }

    return {
      innerWidth: window.innerWidth,
      statusGrid: readGrid('Task ledger'),
      detailGrid: readGrid('Recent tasks'),
      recentTasksWidth: widthOf(recentTasks),
      recentTasksTitle:
        recentTasks
          ?.querySelector('[data-testid="quay-panel-recent-tasks-row"] span:nth-child(2)')
          ?.textContent?.trim() ?? null,
      scroller,
    };
  });

/** Every geometry assertion goes through this, so a failure prints the reading rather than a bare `false`. */
const describeReading = (reading: Reading): string => `reading=${JSON.stringify(reading)}`;
const expectReading = (ok: boolean, message: string, reading: Reading) =>
  expect(ok, `${message}\n  ${describeReading(reading)}`).toBe(true);

/* ── the case ────────────────────────────────────────────────────────────────── */

test.describe('the Quay panel on a 390px phone', () => {
  test.use({ viewport: VIEWPORT, hasTouch: true, isMobile: true });

  test('a long task title stays inside the viewport instead of stretching the grid track', async ({ browser }) => {
    test.setTimeout(45_000);
    seedFixtureProject();

    const bootstrap = await request.newContext({ baseURL: CLIENT_URL });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();
    const api = await request.newContext({
      baseURL: CLIENT_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });

    const context = await browser.newContext({
      baseURL: CLIENT_URL,
      viewport: VIEWPORT,
      hasTouch: true,
      isMobile: true,
    });
    await context.addInitScript(
      ({ key, value }: { key: string; value: string }) => {
        window.localStorage.setItem(key, value);
        window.localStorage.setItem('userLanguage', 'en');
      },
      { key: AUTH_TOKEN_KEY, value: token },
    );
    const page = await context.newPage();

    try {
      await waitForFixtureProject(api);

      // The project is selected from the sidebar listing rather than by deep-linking to its
      // session URL. The session-URL resolver can synthesize a minimal project when the session
      // lookup answers before the project list has loaded, and that synthesized copy carries no
      // `hasQuayConfig`; the sidebar row is the loaded listing's own object, so the Quay view is
      // offered on it. The session exists only so the project does.
      await openRootSidebar(page);
      const projectRow = page.getByText(WORKSPACE_NAME, { exact: true }).first();
      await expect(projectRow, 'the fixture project must be listed in the sidebar').toBeVisible({ timeout: 20_000 });
      // On the compact sidebar a project row toggles its session list open rather than selecting the
      // project outright, so the selection is made through one of its sessions.
      await projectRow.click();
      const sessionRow = page.getByText(SESSION_NAME, { exact: true }).first();
      await expect(sessionRow, 'the fixture session must be listed under its expanded project').toBeVisible({
        timeout: 10_000,
      });
      await sessionRow.click();

      // The mobile workspace header replaces the tablist with a selector dialog, which is how a
      // phone reaches the Quay view at all.
      const selector = page.locator('header [aria-haspopup="dialog"]');
      await expect(selector, 'the workspace selector must render once the fixture project is selected').toBeVisible({
        timeout: 20_000,
      });
      await selector.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      const quayTab = dialog.locator('[data-workspace-tab="quay"]');
      await expect(quayTab, 'the fixture project has a quay config, so its Quay view must be offered').toBeVisible({
        timeout: 10_000,
      });
      await quayTab.click();

      await expect(page.locator('[data-testid="quay-panel-loaded"]')).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('[data-testid="quay-panel-recent-tasks"]')).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(300);

      const reading = await readPanel(page);
      console.log(`[quay-grid] ${describeReading(reading)}`);

      // Premises: the case really is 390 wide, and the long title really is on screen. Without the
      // second one the geometry assertions below could pass because the blow-out input was absent.
      expect(reading.innerWidth, `the case declares ${VIEWPORT.width}px`).toBe(VIEWPORT.width);
      expectReading(
        reading.recentTasksTitle !== null && reading.recentTasksTitle.includes(LONG_TITLE.slice(0, 20)),
        `the fixture's long task title must be the first recent-tasks row, or nothing overflowed`,
        reading,
      );

      // The defect: the recent-tasks list is a grid item, so a blown-out implicit track makes it
      // hundreds of pixels wide on a 390px screen.
      expectReading(
        reading.recentTasksWidth !== null && reading.recentTasksWidth <= VIEWPORT.width + TOLERANCE_PX,
        `the recent-tasks list must stay inside the ${VIEWPORT.width}px viewport (it read ${reading.recentTasksWidth}px)`,
        reading,
      );

      // Both grids below `md`, each block inside the viewport. The status/driver grid reads the
      // same way even though its own content is short: the criterion is the grid's column
      // constraint, not the content that happened to trigger the overflow this time.
      for (const grid of [reading.statusGrid, reading.detailGrid]) {
        expectReading(grid !== null, 'the panel must render both of its responsive grids', reading);
        if (!grid) continue;
        expectReading(
          grid.trackCount === 1,
          `below the md breakpoint the "${grid.name}" grid must resolve to exactly one base track `
            + `(it resolved ${grid.trackCount}: ${grid.templateColumns})`,
          reading,
        );
        for (const block of grid.blocks) {
          expectReading(
            block.width <= VIEWPORT.width + TOLERANCE_PX,
            `the "${block.label}" block of the "${grid.name}" grid must stay inside the ${VIEWPORT.width}px viewport `
              + `(it read ${block.width}px)`,
            reading,
          );
        }
      }

      // And the container that would otherwise clip the overflow: its scroll extent must be no
      // wider than the viewport, which is what "there is nothing hidden past the edge" means.
      expectReading(reading.scroller !== null, 'the panel must have a clipping/scrolling ancestor to read', reading);
      if (reading.scroller) {
        expectReading(
          reading.scroller.scrollWidth <= VIEWPORT.width + TOLERANCE_PX,
          `the nearest ${reading.scroller.kind} ancestor must not overflow the ${VIEWPORT.width}px viewport `
            + `(scrollWidth ${reading.scroller.scrollWidth}px vs clientWidth ${reading.scroller.clientWidth}px)`,
          reading,
        );
      }

      // The second recent-tasks row: its *id*, not its title, is the long value. The id span
      // used to be `shrink-0` with no `truncate`/`min-w-0`, so this row is a distinct overflow
      // source from the long-title row above — pinning it here closes the gap the original
      // fixture (title-only) never exercised.
      const longIdRow = page.getByTestId('quay-panel-recent-tasks-row').nth(1);
      await expect(longIdRow, 'the long-id fixture task must be the second recent-tasks row').toBeVisible();
      const longIdRowBox = await longIdRow.boundingBox();
      expect(longIdRowBox, 'the long-id row must report a bounding box').not.toBeNull();
      if (longIdRowBox) {
        expect(
          longIdRowBox.width,
          `the long-id row must stay inside the ${VIEWPORT.width}px viewport (it read ${longIdRowBox.width}px)`,
        ).toBeLessThanOrEqual(VIEWPORT.width + TOLERANCE_PX);
      }
      // Accessibility: the id is visually ellipsised, not dropped — the full value stays in the
      // DOM text and in a native tooltip (`title`), reachable by hover, assistive tech or
      // automation even though the viewport only has room to show a fraction of it.
      const longIdSpan = longIdRow.locator('span').first();
      await expect(longIdSpan).toHaveAttribute('title', LONG_ID_TASK_ID);
      await expect(longIdSpan).toHaveText(LONG_ID_TASK_ID);

      // Regression reading for the other side of the breakpoint: widening the same document to a
      // desktop width must put both grids back on two tracks without pushing anything past the new
      // viewport. The base column count is a below-`md` floor, not a replacement for the desktop
      // layout, and this is the reading that says so.
      await page.setViewportSize({ width: DESKTOP_VIEWPORT.width, height: DESKTOP_VIEWPORT.height });
      await page.waitForTimeout(300);
      const desktop = await readPanel(page);
      console.log(`[quay-grid] desktop ${describeReading(desktop)}`);
      expect(desktop.innerWidth, `the regression reading declares ${DESKTOP_VIEWPORT.width}px`).toBe(DESKTOP_VIEWPORT.width);
      for (const grid of [desktop.statusGrid, desktop.detailGrid]) {
        expectReading(grid !== null, 'both grids must still render at the desktop width', desktop);
        if (!grid) continue;
        expectReading(
          grid.trackCount === 2,
          `at ${DESKTOP_VIEWPORT.width}px the "${grid.name}" grid must keep its two desktop columns `
            + `(it resolved ${grid.trackCount}: ${grid.templateColumns})`,
          desktop,
        );
        for (const block of grid.blocks) {
          expectReading(
            block.width <= DESKTOP_VIEWPORT.width + TOLERANCE_PX,
            `the "${block.label}" block must stay inside the ${DESKTOP_VIEWPORT.width}px viewport (it read ${block.width}px)`,
            desktop,
          );
        }
      }
      if (desktop.scroller) {
        expectReading(
          desktop.scroller.scrollWidth <= DESKTOP_VIEWPORT.width + TOLERANCE_PX,
          `the nearest ${desktop.scroller.kind} ancestor must not overflow the ${DESKTOP_VIEWPORT.width}px viewport`,
          desktop,
        );
      }
    } finally {
      await context.close();
      await api.dispose();
    }
  });
});
