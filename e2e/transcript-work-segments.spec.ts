import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// AC-207: in a real browser, the default collapsed transcript is under half its unmerged density, and a search
// hit that lands on a member of a collapsed work segment opens that segment and puts the member on screen.
//
// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data dir).
// Nothing here stubs a request: the fixture session is a real Claude transcript seeded into the run's isolated
// HOME before the server booted and indexed by the backend's own synchronizer (see `seedWorkSegmentTranscript`
// in playwright.config.ts), opened over the app's own routing, and searched through the sidebar's real
// conversation search — the SSE-backed one — whose click is the only source of `__searchTargetSnippet`.
//
// ── Fixture provenance, recorded because the criterion asks for it (AC7). ──────────────────────────────────
// The fixture comes from the seed's plain-claude JSONL above, NOT from the debug-agent seam this spec is also
// registered under in `DEBUG_AGENT_SPEC_FILES`. The debug seam's scenario dialect is a closed set whose `row`
// carries only `{role, text}` (server/modules/debug-agent/debug-agent.scenario.ts), and it cannot write a
// thinking or tool-use row — precisely the rows a work segment is made of (AC-202's membership rule). So
// neither reading below may be attributed to that gate; the registration exists only to pin that fact.

/** ChatMessagesPane's scroll container. */
const PANE = '.chat-messages-pane';
/** The row class `MessageComponent` draws (and `WorkSegmentRecord`'s header reuses). */
const ROW = '.chat-message';
/** Session the seeded transcript belongs to; mirrors playwright.config.ts's own seed. */
const SESSION_ID = 'e2e-work-segment';
/** Display name the sidebar renders for it. */
const SESSION_NAME = 'work-segment';
/** The one phrase the fixture plants; see the seed for why it lives in two rows. */
const HIT_PHRASE =
  'The quick brown fox jumps over the lazy dog near the riverbank at dawn while the beacon glows amber';
/** Fixed viewport, so the height readings below are reproducible run to run. */
const VIEWPORT = { width: 1280, height: 1200 };

/**
 * The unmerged density of the fixture's one turn, from playwright.config.ts's own seed.
 *
 * Baseline provenance: one turn of 24 rows — 20 work rows (8 thinking at ~36px, 6 tool calls at ~60px, plus
 * the remainder) across three runs, and 4 text rows — measuring 1112px before any merging. These four numbers
 * are the AC's own constants; the assertions below are floors (`<` the limit for the collapsed reading, `>=`
 * the baseline for its positive control), so the fixture only has to clear them, not equal them.
 */
const PRE_MERGE_BASELINE_ROWS = 24;
const PRE_MERGE_BASELINE_PX = 1112;
/** Half the baseline, rounded down: what "under half the unmerged density" means in rows. */
const ROW_LIMIT = 12;
/** Half the baseline, rounded down, in CSS pixels. */
const PX_LIMIT = 556;

/** Signs in, creating the account on the first run of the fixture database. */
const ensureSignedIn = async (page: Page) => {
  // The app shell. Loaded here rather than through a bare `goto` + a long locator wait: a first document whose
  // module graph is holed (a dependency re-optimization the page raced, or the service worker's claim landing
  // mid-load) stays blank until something reloads it, and a locator with nothing under it just waits out its
  // ceiling. Bounded reloads, then a named failure — the discipline e2e/transcript-follow.spec.ts settled on.
  const shellReady = () =>
    page
      .locator('button:has-text("Create Account"), button:has-text("Settings"), #username')
      .first()
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true, () => false);

  await page.goto('/');
  let ready = await shellReady();
  for (let attempt = 0; !ready && attempt < 3; attempt += 1) {
    await page.reload().catch(() => undefined);
    ready = await shellReady();
  }
  if (!ready) throw new Error('the app shell never rendered; the page had no Create Account / Settings / #username');

  const createAccount = page.getByRole('button', { name: 'Create Account' });
  const settings = page.getByRole('button', { name: 'Settings' }).first();
  if (await createAccount.count()) {
    await page.locator('#username').fill('e2euser');
    await page.locator('input[type=password]').nth(0).fill('e2epassword');
    await page.locator('input[type=password]').nth(1).fill('e2epassword');
    await createAccount.click();
    await page.getByPlaceholder('John Doe').fill('E2E User');
    await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Complete Setup' }).click();
    await expect(settings).toBeVisible({ timeout: 15_000 });
  } else if (await page.locator('#username').count()) {
    await page.locator('#username').fill('e2euser');
    await page.locator('input[type=password]').first().fill('e2epassword');
    await page.locator('form button[type=submit]').click();
    await expect(settings).toBeVisible({ timeout: 15_000 });
  }
};

/**
 * Fetches the client's entry and its pre-bundled dependency before the page does, so the first navigation does
 * not race Vite's optimizer. The same warm-up e2e/transcript-follow.spec.ts performs, kept compact.
 */
const OPTIMIZED_DEP_IN_TEXT = /from\s+"(\/node_modules\/\.vite\/deps\/[^"]+)"/;
const warmClientStartup = async (clientUrl: string): Promise<void> => {
  const deadline = Date.now() + 20_000;
  const fetchWithin = async (url: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  const shell = await fetchWithin(new URL('/', clientUrl).href);
  await shell.text();
  const entry = await fetchWithin(new URL('/src/main.tsx', clientUrl).href);
  const specifier = OPTIMIZED_DEP_IN_TEXT.exec(await entry.text())?.[1];
  if (specifier) {
    // A 200 here means the page below will not race the optimizer; the body is drained so the socket closes.
    const dep = await fetchWithin(new URL(specifier, clientUrl).href);
    await dep.text().catch(() => undefined);
  }
};

/** Lets the app's service worker finish claiming the first document, so the measured navigation is not the load it holes. */
const settleServiceWorker = (page: Page) =>
  page
    .waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 10_000 })
    .catch(() => undefined);

type Density = { rows: number; heightPx: number };

/**
 * Counts the mounted transcript rows and measures the turn's total height, after layout has settled.
 *
 * The height is the span from the first row's top to the last row's bottom: nested rows (a segment's members
 * live inside its header's box) make a sum of the rectangles double-count, while the span is the box the
 * transcript actually occupies. Read a frame on, so a write deferred to its own frame lands first — the same
 * rAF-then-timeout discipline e2e/transcript-follow.spec.ts uses for its geometry.
 */
const readDensity = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<Density>((resolve) => {
        requestAnimationFrame(() => {
          setTimeout(() => {
            const rows = Array.from(document.querySelectorAll('.chat-message'));
            if (rows.length === 0) {
              resolve({ rows: 0, heightPx: 0 });
              return;
            }
            const first = rows[0].getBoundingClientRect();
            const last = rows[rows.length - 1].getBoundingClientRect();
            resolve({ rows: rows.length, heightPx: Math.round(last.bottom - first.top) });
          }, 0);
        });
      }),
  );

/** Reads until two consecutive samples agree, so a late reflow cannot be mistaken for the settled height. */
const settledDensity = async (page: Page): Promise<Density> => {
  let previous: Density | null = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = await readDensity(page);
    if (
      previous
      && current.rows === previous.rows
      && Math.abs(current.heightPx - previous.heightPx) <= 1
    ) {
      return current;
    }
    previous = current;
    await page.waitForTimeout(100);
  }
  throw new Error('the transcript density never settled');
};

/**
 * The fixture's oldest row: the one user prompt, and the only row that lives exclusively in the older page.
 * See {@link awaitWholeFixtureWindow} for why that makes it the witness for "the pane holds the whole turn".
 */
const FIXTURE_FIRST_ROW = 'Show me the release notes for the work segment browser.';

/**
 * Establishes, on the document the readings below are taken from, that the pane holds the WHOLE fixture turn
 * — not only the newest page of it.
 *
 * The client opens a session on its newest `SESSION_MESSAGES_PAGE_SIZE` rows (20) and reads the older page
 * (`offset=20`) only after the first paint has written a scroll offset. The fixture is 24 rows, so between
 * those two moments the pane is a strict prefix of the transcript: the first run is missing three of its
 * seven members and the collapsed drawing is 6 rows / 329px instead of 7 / ~410px. That shorter window
 * passes the "under half the unmerged density" thresholds for the wrong reason — the pane is short because
 * the window is partial, not because the merging withheld rows — and the run then reds one reading later,
 * on a header count. The readings are about the app's merging, so they must be taken on a pane that holds
 * the whole turn.
 *
 * The witness is the fixture's first row, the user prompt. It lives exclusively in the older page (the
 * newest-20 window starts three members into the first run), so its presence in the measured pane's DOM
 * means that page has landed and the window is the whole 24-row turn. It is a DOM reading of the same
 * document the density and header readings are taken from — a restart that remounts the pane between this
 * wait and those readings is caught by their own settled/re-read discipline, and this wait is repeated
 * beside each density reading. Unlike a member count or a density, no partial window can satisfy it.
 */
const awaitWholeFixtureWindow = (page: Page) =>
  expect(
    page.locator(`${PANE} ${ROW}`, { hasText: FIXTURE_FIRST_ROW }).first(),
    'the pane never showed the fixture’s first row: the older page had not landed, so the transcript held '
      + 'only its newest 20 rows and would be measured as a short (but not merged) turn',
  ).toBeVisible({ timeout: 30_000 });

type SegmentState = {
  key: string | null;
  /** The member rows actually in the DOM — zero for a collapsed segment. */
  members: { timestamp: string | null; text: string }[];
};

type SegmentTitle = {
  /** The run's current action, as the collapsed header renders it. */
  action: string;
  /** How many rows the header says the run absorbed. */
  count: number;
  /** The run's elapsed span in milliseconds, as the header carries it. */
  elapsedMs: number;
};

/**
 * Reads the three readings off every work-segment header — the run's current action, the number of rows it
 * absorbed and its elapsed span — straight from the header's own render, never recomputed here. Used by the
 * AC-208 reading below to check the collapsed transcript actually draws a title derived from each segment.
 */
const readSegmentTitles = (page: Page) =>
  page.evaluate((): SegmentTitle[] =>
    Array.from(document.querySelectorAll('[data-work-segment-key]')).map((seg) => {
      const header = seg.querySelector('.chat-message.work-segment');
      return {
        action: header?.querySelector('[data-work-segment-action]')?.textContent?.trim() ?? '',
        count: Number(header?.getAttribute('data-work-segment-count')),
        elapsedMs: Number(header?.getAttribute('data-work-segment-elapsed-ms')),
      };
    }),
  );

/** Reads every work segment's expanded state from the DOM, members and all. */
const readSegments = (page: Page) =>
  page.evaluate((): SegmentState[] =>
    Array.from(document.querySelectorAll('[data-work-segment-key]')).map((seg) => {
      // The header is itself a `.chat-message`; the members are its descendants that match too.
      const all = Array.from(seg.querySelectorAll('.chat-message'));
      const members = all.slice(1).map((row) => ({
        timestamp: row.getAttribute('data-message-timestamp'),
        text: row.textContent || '',
      }));
      return { key: seg.getAttribute('data-work-segment-key'), members };
    }),
  );

test.describe.configure({ timeout: 120_000 });

test.describe('work segment density and search expand', () => {
  // Both readings live in one case so the run boots its server and Vite client once; a second case would pay
  // a second boot and, worse, a second sign-in on a fresh context — the flakiest part of the fixture.
  test('AC-207 collapsed density is under half the unmerged baseline, and a sidebar search hit opens its segment', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL for the startup warm-up');
    await warmClientStartup(clientUrl);
    await ensureSignedIn(page);
    await settleServiceWorker(page);
    await page.goto(`/session/${SESSION_ID}`);
    await page.locator(`${PANE} ${ROW}`).first().waitFor({ state: 'visible', timeout: 30_000 });

    // ── Reading (i): the default, nothing expanded. ──────────────────────────────────────────────────────
    // Take the reading only once the pane holds the whole fixture turn; a pane still on its newest page is
    // shorter than the transcript, and would read as "merged" while merely being partial (see the helper).
    await awaitWholeFixtureWindow(page);
    const collapsed = await settledDensity(page);
    expect(
      collapsed.rows,
      `the collapsed transcript drew ${collapsed.rows} rows at height ${collapsed.heightPx}px`,
    ).toBeLessThan(ROW_LIMIT);
    expect(
      collapsed.heightPx,
      `the collapsed transcript measured ${collapsed.heightPx}px over ${collapsed.rows} rows`,
    ).toBeLessThan(PX_LIMIT);

    // The segment's own header button — a direct child of the header record. Scoped this tightly because an
    // expanded member's own reasoning block exposes an `aria-expanded` trigger of its own, and an unscoped
    // `[aria-expanded]` locator would toggle those instead of opening the next segment.
    const headers = page.locator(`${PANE} [data-work-segment-key] > .chat-message.work-segment > button[aria-expanded]`);
    const headerCount = await headers.count();
    expect(headerCount, 'the fixture draws three work segments').toBe(3);

    // ── Reading (iii, AC-208): the collapsed header names its run — action, count and elapsed. ───────────
    // The fixture is three runs of 7, 8 and 5 members, one second apart (see `seedWorkSegmentTranscript`), so
    // the three readings are pinned by the data: counts {5,7,8}; every span multi-second; and each run titled
    // by its own LAST member — the two thinking-terminated runs read "Thinking", the Bash-terminated one
    // "Bash". Reading them off the collapsed headers is the browser evidence that the title is derived from
    // the segment rather than a constant string, which is exactly what unit greens alone could not show.
    const titles = await readSegmentTitles(page);
    expect(titles, 'the fixture draws three oriented work segments').toHaveLength(3);
    expect(
      titles.map((title) => title.count).sort((a, b) => a - b),
      'each header count is its run’s member count (7, 8 and 5 in the fixture)',
    ).toEqual([5, 7, 8]);
    for (const title of titles) {
      expect(title.action, 'the header names the run’s current action').not.toBe('');
      expect(
        title.elapsedMs,
        `a multi-second run must report a non-zero span, got ${title.elapsedMs}ms for a ${title.count}-row run`,
      ).toBeGreaterThanOrEqual(4_000);
    }
    const titleByCount = new Map(titles.map((title) => [title.count, title]));
    expect(titleByCount.get(8)?.action, 'the run ending on a Bash call is titled by that call').toBe('Bash');
    expect(titleByCount.get(7)?.action, 'a run ending on a thinking row is titled by that row').toBe('Thinking');
    expect(titleByCount.get(5)?.action, 'the second thinking-terminated run reads the same way').toBe('Thinking');
    expect(
      new Set(titles.map((title) => title.action)).size,
      'the action is derived per run, not one constant across every header',
    ).toBeGreaterThan(1);

    // Open (or close) every segment and read the density while it holds, tolerating the client replacing the
    // document underneath the reading.
    //
    // This run's client is Vite, and Vite can replace the document whole mid-run: a re-optimization committed
    // after the server began serving — the `504 Outdated Optimize Dep` this run's shared dependency cache can
    // still hand back, the failure the sibling criteria settle with their own bounded reloads — is answered by
    // pushing `full-reload` to every connected client. A reload between the clicks remounts the pane, and
    // AC-204's contract starts a fresh pane collapsed, so the segments opened before the reload are shut again
    // while the ones after it stay open: the transcript reads half-open (20 rows, under the baseline) though the
    // app did nothing wrong. The control's claim is about the app's density with every segment open, so that
    // precondition is established on the document the density is actually read from — and re-established,
    // bounded, if a reload tore that document down — rather than assumed to have survived a restart. Only the
    // state the assertions read is held; the thresholds and the comparisons are untouched.
    const settledDensityWithEverySegment = async (open: boolean): Promise<Density> => {
      const target = String(open);
      const readHeaderStates = () =>
        headers.evaluateAll((els) => els.map((el) => el.getAttribute('aria-expanded')));
      for (let attempt = 0; attempt < 4; attempt += 1) {
        for (let index = 0; index < headerCount; index += 1) {
          const button = headers.nth(index);
          await button.scrollIntoViewIfNeeded();
          if ((await button.getAttribute('aria-expanded')) !== target) {
            await button.click();
          }
          await expect(button, `header ${index} of ${headerCount}`).toHaveAttribute('aria-expanded', target);
        }
        const states = await readHeaderStates();
        if (!(states.length === headerCount && states.every((state) => state === target))) {
          // A restart replaced the document mid-pass; let the fresh one settle and re-apply there.
          await page.locator(`${PANE} ${ROW}`).first().waitFor({ state: 'visible', timeout: 30_000 });
          await awaitWholeFixtureWindow(page);
          continue;
        }
        const density = await settledDensity(page);
        // Re-read the states beside the density: a restart landing between the pass and the reading would
        // otherwise let a half-open transcript stand in for the all-open control.
        const settledStates = await readHeaderStates();
        if (settledStates.length === headerCount && settledStates.every((state) => state === target)) {
          return density;
        }
        await page.locator(`${PANE} ${ROW}`).first().waitFor({ state: 'visible', timeout: 30_000 });
        await awaitWholeFixtureWindow(page);
      }
      throw new Error(
        `the transcript never held every segment ${open ? 'open' : 'collapsed'} through a density reading; `
        + 'the client kept restarting the document',
      );
    };

    // (i)'s positive control: every segment open, so the member rows merging withheld are all on screen. A
    // member draws the same height open as it would unmerged, so this is the unmerged density — and it is what
    // proves the two thresholds separate collapsed from unmerged rather than holding for any input.
    const expanded = await settledDensityWithEverySegment(true);
    console.log('[AC-207] collapsed', JSON.stringify(collapsed), 'expanded-positive-control', JSON.stringify(expanded));
    expect(
      expanded.rows,
      `with every segment open the transcript drew ${expanded.rows} rows`,
    ).toBeGreaterThanOrEqual(PRE_MERGE_BASELINE_ROWS);
    expect(
      expanded.heightPx,
      `with every segment open the transcript measured ${expanded.heightPx}px`,
    ).toBeGreaterThanOrEqual(PRE_MERGE_BASELINE_PX);
    expect(expanded.rows, 'the control really is the denser state').toBeGreaterThan(collapsed.rows);

    // Back to the default a user arrives at, so reading (ii) starts from the collapsed transcript.
    const recollapsed = await settledDensityWithEverySegment(false);
    expect(recollapsed.rows, 'collapsing restores the default density').toBe(collapsed.rows);
    expect((await readSegments(page)).every((segment) => segment.members.length === 0), 'all segments start collapsed').toBe(true);

    // ── Reading (ii): a real sidebar search whose hit lands on a collapsed member. ───────────────────────
    // Typing the phrase streams results over SSE; the click hands the app the snippet and timestamp — there is
    // no other source of `__searchTargetSnippet` in this run.
    await page.locator('button:visible', { hasText: 'Conversations' }).first().click();
    await page.locator('input.nav-search-input:visible').first().fill(HIT_PHRASE);

    const result = page.getByRole('button').filter({ hasText: SESSION_NAME }).first();
    await result.waitFor({ state: 'visible', timeout: 30_000 });
    await expect(result, 'the search result carries the hit snippet').toContainText('quick brown fox');
    await result.click();

    await expect(page).toHaveURL(new RegExp(`/session/${SESSION_ID}$`), { timeout: 20_000 });

    // Wait for the hit segment to open — the behaviour under test. Nothing here clicks a segment header.
    const hitSegmentKey = 'message-assistant-seg-tool-4';
    await expect
      .poll(async () => (await readSegments(page)).find((seg) => seg.key === hitSegmentKey)?.members.length ?? 0, {
        timeout: 20_000,
        message: 'the segment holding the search hit never opened',
      })
      .toBeGreaterThan(0);

    const segments = await readSegments(page);
    const opened = segments.filter((seg) => seg.members.length > 0);

    // (c) driven by the hit, not "expand everything": exactly the hit's segment is open, the others are not.
    for (const seg of segments) {
      if (seg.key === hitSegmentKey) {
        expect(seg.members.length, 'the hit segment is the open one').toBeGreaterThan(0);
      } else {
        expect(seg.members.length, `segment ${seg.key} must stay collapsed`).toBe(0);
      }
    }
    expect(opened, 'only one segment is open, and it is driven by the hit').toHaveLength(1);

    const hitSegment = segments.find((seg) => seg.key === hitSegmentKey);
    if (!hitSegment) throw new Error(`the hit segment ${hitSegmentKey} was not rendered`);

    // (AC5) The phrase sits on a non-first member of a run of at least three, so the "scroll to the segment
    // row and leave the content collapsed" pathology is genuinely reachable.
    const hitMemberIndex = hitSegment.members.findIndex((member) => member.text.includes(HIT_PHRASE));
    expect(hitMemberIndex, 'the phrase is a member of the hit segment').toBeGreaterThanOrEqual(0);
    expect(hitMemberIndex, 'the phrase is NOT the segment’s first member').toBeGreaterThanOrEqual(1);
    expect(hitSegment.members.length, 'the hit segment holds at least three members').toBeGreaterThanOrEqual(3);

    // (a)+(b) The member's own row is in the DOM and its rect lies wholly inside the pane's viewport. The row
    // is named positionally inside the hit segment, because the same phrase also closes the turn as a text row
    // — that row is a boundary, not a member, and must not be mistaken for the hit.
    const memberRows = page.locator(
      `${PANE} [data-work-segment-key="${hitSegmentKey}"] .chat-message[data-message-timestamp]`,
    );
    await expect(memberRows, 'the hit segment draws one row per member').toHaveCount(hitSegment.members.length);
    const hitRow = memberRows.nth(hitMemberIndex);
    await expect(hitRow).toContainText('quick brown fox');
    const geometry = await hitRow.evaluate((row) => {
      const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
      const rowRect = row.getBoundingClientRect();
      const paneRect = pane.getBoundingClientRect();
      return {
        top: rowRect.top,
        bottom: rowRect.bottom,
        paneTop: paneRect.top,
        paneBottom: paneRect.bottom,
      };
    });
    expect(
      geometry.top,
      `hit row top ${geometry.top} vs pane top ${geometry.paneTop}`,
    ).toBeGreaterThanOrEqual(geometry.paneTop);
    expect(
      geometry.bottom,
      `hit row bottom ${geometry.bottom} vs pane bottom ${geometry.paneBottom}`,
    ).toBeLessThanOrEqual(geometry.paneBottom);
  });
});
