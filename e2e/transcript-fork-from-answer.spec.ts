import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// gap-fork-from-assistant-reply-anchor, DoD legs (1) and (2), read in a real browser.
//
// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data dir).
// Nothing here stubs a request: the fixture session is a real Claude transcript seeded into the run's isolated
// HOME before the server booted and indexed by the backend's own synchronizer (see `seedForkAnchorTranscript` in
// playwright.config.ts), opened over the app's own routing. The fork is the SHIPPED path end to end — the button's
// own `onClick`, `ChatInterface.handleForkFromMessage`, `api.forkSession`, the route, `sessionsService.forkSessionById`
// and the Claude Agent SDK's real `forkSession` — and the branch is then read off the disk by this file, not off the
// app's rendering of it.
//
// ── Which DoD legs this covers, and which it does not. ──────────────────────────────────────────────────────
// (1) every turn's final reply carries the button and the user bubbles do not — asserted below.
// (2) forking at the first turn's reply lands a transcript whose last message row IS that reply and which holds
//     nothing from the second turn — asserted below, by reading the file the SDK wrote.
// (3) that a message sent inside the fork is answered with only the first turn in context — NOT here. It needs a
//     live model to answer, and this fixture is an offline transcript. Left unread rather than approximated; see
//     the task's completion record.
// (4) the button's absence while a turn is running — NOT here. It needs a live turn to be running; the same
//     absence and its positive control are read at component level in
//     src/modules/chat/tests/forkFromAssistantReply.test.tsx.

/** ChatMessagesPane's scroll container, and the row class `MessageComponent` draws. */
const PANE = '.chat-messages-pane';
const ROW = '.chat-message';
/** Session the seeded transcript belongs to; mirrors playwright.config.ts's own seed. */
const SESSION_ID = '99999999-9999-4999-8999-999999999999';
/** The fixture's own phrases; the seed and this file have to name the same rows. */
const FIRST_PROMPT = 'Show me the release notes.';
const FIRST_ANSWER = 'The first answer, about the release notes.';
const SECOND_PROMPT = 'Now summarise the second section.';
const SECOND_ANSWER = 'The second answer, about the changelog.';
/** The label `MessageComponent` puts on the control. */
const FORK_LABEL = 'Fork from here';
/** Fixed viewport, so the rows below are on screen without the reader having to scroll for them. */
const VIEWPORT = { width: 1280, height: 1200 };

/** Signs in, creating the account on the first run of the fixture database. */
const ensureSignedIn = async (page: Page) => {
  // The app shell. Loaded here rather than through a bare `goto` + a long locator wait: a first document whose
  // module graph is holed stays blank until something reloads it, and a locator with nothing under it just waits
  // out its ceiling. Bounded reloads, then a named failure — the discipline e2e/transcript-work-segments.spec.ts
  // settled on.
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
 * not race Vite's optimizer. The same warm-up the other transcript specs perform, kept compact.
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
    const dep = await fetchWithin(new URL(specifier, clientUrl).href);
    await dep.text().catch(() => undefined);
  }
};

/**
 * The directory the run's seeded transcript sits in, found by looking for the session's own file.
 *
 * Searched rather than recomputed from the seed's arithmetic: the fixture's directory name is
 * `sanitize(cwd)`, and this file would have to reproduce the SDK's sanitizer (and its 200-character hash) to
 * derive it — a second copy of that rule, in a second language of expression, for no reading this spec takes.
 * Looking for the file answers the only question asked here — where did the run put this session? — and the
 * fork's output lands in the same directory, which is what the branch is read out of below.
 */
const transcriptDirFor = (sessionId: string): string => {
  const dataDir = process.env.QUAY_E2E_DATA_DIR;
  if (!dataDir) {
    throw new Error('QUAY_E2E_DATA_DIR is unset; playwright.config.ts publishes the run data directory through it');
  }
  const projectsRoot = path.join(dataDir, '.claude', 'projects');
  for (const entry of fs.readdirSync(projectsRoot)) {
    const candidate = path.join(projectsRoot, entry);
    if (fs.existsSync(path.join(candidate, `${sessionId}.jsonl`))) {
      return candidate;
    }
  }
  throw new Error(`no seeded transcript for ${sessionId} under ${projectsRoot}`);
};

/** The message rows of a transcript file, in file order, as the SDK left them. */
const readMessageRows = (filePath: string): { type?: string; message?: { content?: unknown } }[] =>
  fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { type?: string; message?: { content?: unknown } })
    .filter((row) => row.type === 'user' || row.type === 'assistant');

test.describe.configure({ timeout: 120_000 });

test.describe('fork from the turn-ending answer', () => {
  // One case, because both legs need the same boot and the same live page — a second case would pay a second
  // server boot and a second sign-in on a fresh context, the flakiest part of the fixture — and because leg (2)
  // is only meaningful on the page leg (1) was read from.
  test('the fork control sits on each turn-ending reply, and forking at the first one branches the transcript there', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL for the startup warm-up');
    await warmClientStartup(clientUrl);
    await ensureSignedIn(page);

    const transcriptDir = transcriptDirFor(SESSION_ID);
    // The files the directory holds before the fork, so the branch can be told from everything else after it.
    const beforeFork = new Set(fs.readdirSync(transcriptDir));

    await page.goto(`/session/${SESSION_ID}`);
    await page.locator(`${PANE} ${ROW}`).first().waitFor({ state: 'visible', timeout: 30_000 });

    /**
     * The one transcript row carrying a piece of text.
     *
     * Rows are told apart by their content, not by position: the reading is about *which* row holds the control,
     * so the row has to be the one that says the thing, or a reordering could hand the assertion to the wrong row.
     */
    const rowFor = (marker: string) => page.locator(`${PANE} ${ROW}`).filter({ hasText: marker }).first();
    const forkButtonIn = (row: ReturnType<typeof rowFor>) => row.locator(`button[aria-label="${FORK_LABEL}"]`);

    // Premise: both turns really are on screen. Without this, an absence below would read the same against a row
    // that never rendered.
    await expect(rowFor(FIRST_PROMPT), 'the fixture must draw the first prompt').toBeVisible();
    await expect(rowFor(FIRST_ANSWER), 'the fixture must draw the first turn’s answer').toBeVisible();
    await expect(rowFor(SECOND_ANSWER), 'the fixture must draw the second turn’s answer').toBeVisible();

    // ── Leg (1): the control is on each turn's final reply... ──────────────────────────────────────────────
    await expect(
      forkButtonIn(rowFor(FIRST_ANSWER)),
      'the first turn’s final reply must offer the fork control',
    ).toHaveCount(1);
    await expect(
      forkButtonIn(rowFor(SECOND_ANSWER)),
      'the second turn’s final reply must offer the fork control',
    ).toHaveCount(1);

    // ...and nowhere else. The prompt is the row the control used to sit on, and the second prompt is what proves
    // this is about the row's kind rather than about being the first one seen.
    await expect(
      forkButtonIn(rowFor(FIRST_PROMPT)),
      'the user’s prompt must offer no fork control',
    ).toHaveCount(0);
    await expect(
      forkButtonIn(rowFor(SECOND_PROMPT)),
      'the user’s second prompt must offer no fork control either',
    ).toHaveCount(0);

    // ── Leg (1a): and it is actually visible to a mouse, without hovering. ────────────────────────────────
    //
    // PRESENCE IS NOT VISIBILITY. Playwright's own `toBeVisible()` counts an `opacity: 0` element as visible,
    // so the two counts above would stay green on a control the browser draws as fully transparent — which is
    // exactly what a `opacity-0 … group-hover:opacity-100` button is before a pointer reaches an ancestor
    // carrying `.group`. This leg reads the browser's own computed style instead, where the transparent value
    // is not a class name that a non-Tailwind environment could fail to apply but the number the paint uses.
    /**
     * The un-hovered opacity and box of a control, printed so the run's log carries the reading.
     *
     * The pointer is parked in the viewport's corner and neither the row nor the button is sent `hover()` or
     * `focus()`, so a control whose visibility waits on `:hover` stays at its un-hovered value: this is the
     * 未悬停 reading the criterion asks for, and it is the half that a "hover first, then read" reading would
     * hollow out. `getBoundingClientRect()` answers the other half — an `opacity: 1` element still occupies no
     * space if it is drawn at zero size.
     */
    const readUnhoveredForkControl = async (button: ReturnType<typeof forkButtonIn>) => {
      await page.mouse.move(1, 1);
      const reading = await button.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return {
          opacity: Number(getComputedStyle(el).opacity),
          width: rect.width,
          height: rect.height,
        };
      });
      console.log(`forkButtonOpacity=${reading.opacity} rect=${reading.width}x${reading.height}`);
      return reading;
    };

    const firstVisibility = await readUnhoveredForkControl(forkButtonIn(rowFor(FIRST_ANSWER)));
    expect(
      firstVisibility.opacity,
      'the first reply’s fork control must be visible to a mouse while 未悬停 (no hover/focus): its computed opacity must be 1, not the transparent value a `group-hover:` rule leaves it at',
    ).toBeGreaterThanOrEqual(0.99);
    expect(firstVisibility.width, 'the first reply’s fork control must occupy a non-zero width').toBeGreaterThan(0);
    expect(firstVisibility.height, 'the first reply’s fork control must occupy a non-zero height').toBeGreaterThan(0);

    const secondVisibility = await readUnhoveredForkControl(forkButtonIn(rowFor(SECOND_ANSWER)));
    expect(
      secondVisibility.opacity,
      'the second reply’s fork control must be visible to a mouse while 未悬停 (no hover/focus): its computed opacity must be 1',
    ).toBeGreaterThanOrEqual(0.99);
    expect(secondVisibility.width, 'the second reply’s fork control must occupy a non-zero width').toBeGreaterThan(0);
    expect(secondVisibility.height, 'the second reply’s fork control must occupy a non-zero height').toBeGreaterThan(0);

    // The DoD's screenshot leg, kept in the shipped spec so the evidence is reproducible: the answer's action bar
    // itself, so the copy, speak and fork controls are readable side by side in one image. Taken from the bar, not
    // the row, because the claim is about those three controls sharing a line — a whole-row shot would also carry
    // the reply text and blur what is being pointed at.
    const actionBar = forkButtonIn(rowFor(FIRST_ANSWER)).locator('xpath=..');
    const actionBarShot = test.info().outputPath('fork-answer-action-bar.png');
    await actionBar.screenshot({ path: actionBarShot });
    console.log(`forkActionBarScreenshot=${actionBarShot}`);

    // ── Leg (2): forking at the first answer branches the transcript there. ────────────────────────────────
    await forkButtonIn(rowFor(FIRST_ANSWER)).click();

    // The branch's own file. It is named by the id the SDK minted for the copied transcript, which is NOT the
    // address the app opens: `forkSessionById` stores the branch under a fresh *app* id and keeps the SDK's id
    // as the row's provider id, so tying the file to the URL would be asserting a relationship the product
    // deliberately does not have. What the two really share is the source — the file is the one new transcript
    // in the directory, and it records the session it was cut from.
    let forkedPath: string | null = null;
    const deadline = Date.now() + 20_000;
    while (forkedPath === null && Date.now() < deadline) {
      const appeared = fs.readdirSync(transcriptDir).filter((entry) => entry.endsWith('.jsonl') && !beforeFork.has(entry));
      if (appeared.length === 1) {
        forkedPath = path.join(transcriptDir, appeared[0]);
      } else if (appeared.length > 1) {
        throw new Error(`the fork wrote ${appeared.length} transcripts into ${transcriptDir}: ${appeared.join(', ')}`);
      } else {
        await page.waitForTimeout(200);
      }
    }
    expect(forkedPath, `the fork must write a transcript beside its source in ${transcriptDir}`).not.toBeNull();

    // "A new session opened": the address has left the source and names a session of its own.
    await expect(page, 'forking must open the new session').not.toHaveURL(new RegExp(SESSION_ID), { timeout: 15_000 });
    await expect(page, 'the new session is addressed by its own id').toHaveURL(/\/session\/[0-9a-f-]{36}(?:$|[/?#])/);

    const rows = readMessageRows(forkedPath as string);
    // The branch says where it came from, so this file can be tied to the session the page opened rather than
    // merely to a file that appeared in the directory at the same moment.
    expect(
      rows.some((row) => JSON.stringify(row).includes(SESSION_ID)),
      'the branch must record the session it was cut from',
    ).toBe(true);
    const lastRow = rows[rows.length - 1];
    // The SDK appends a `custom-title` bookkeeping row of its own; the last *message* row is what the
    // conversation ends on, and it has to be the reply the button was pressed on.
    expect(
      lastRow?.type,
      `the branch must end on the assistant's reply; it ended on ${JSON.stringify(lastRow?.message?.content)}`,
    ).toBe('assistant');
    expect(lastRow?.message?.content).toEqual([{ type: 'text', text: FIRST_ANSWER }]);

    // Nothing from the second turn leaked into the branch.
    const leaked = rows.filter((row) => JSON.stringify(row.message?.content ?? '').includes(SECOND_ANSWER));
    expect(leaked, 'the branch must not hold the second turn’s answer').toEqual([]);
    const leakedPrompt = rows.filter((row) => JSON.stringify(row.message?.content ?? '').includes(SECOND_PROMPT));
    expect(leakedPrompt, 'the branch must not hold the second turn’s prompt').toEqual([]);

    // The cut lands after the whole first turn, so the tool call it made still has the result that answered it.
    // A cut placed beside the intermediate text would leave `fork-tool-1` with nothing answering it.
    const toolUseIds: string[] = [];
    const toolResultIds: string[] = [];
    for (const row of rows) {
      const content = row.message?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content as { type?: string; id?: string; tool_use_id?: string }[]) {
        if (part.type === 'tool_use' && part.id) toolUseIds.push(part.id);
        if (part.type === 'tool_result' && part.tool_use_id) toolResultIds.push(part.tool_use_id);
      }
    }
    expect(
      toolUseIds.filter((id) => !toolResultIds.includes(id)),
      'the branch must not leave a tool call unanswered',
    ).toEqual([]);
  });
});
