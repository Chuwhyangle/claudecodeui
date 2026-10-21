import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import {
  navigateClientBounded,
  warmClientStartup,
  type ClientStartupEvidence,
  type RequestFailure,
} from './support/client-startup-warmup';

// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data dir).
//
// The subject is the Conversations feed — the sidebar's recents list, `GET /api/providers/sessions/recent` —
// and what it does with a transcript that appears on disk *while the user is sitting on it*. That feed is
// patched in place from `session_upserted` deltas, and a reload of the same feed is filtered server-side by
// the owning project's session-name rules. The reported bug is the gap between the two: the reload dropped a
// worker session, the live list kept it, so a rule the user had already saved looked broken until they
// navigated away and back. This spec drives that exact sequence and judges the live list against a real
// reload of itself, so what is asserted is an equivalence between what the app shows and what the app's own
// server would return — not a restatement of the client's rule code.
//
// Why this is not a case inside e2e/session-filter.spec.ts: that spec is about the *Projects* list, and the
// two lists do not answer the same question. The Projects list judges with exemptions — the session the user
// has selected, the sessions flagged as needing attention — because those rows are the user's own working set.
// The Conversations feed has no selection and deliberately applies none of them, because the reload it has to
// match applies none: `/sessions/recent` filters on the project's rules and nothing else. A live view that
// kept a row the reload drops is the bug; being the more permissive of the two is precisely how it happened.
//
// Every session this spec filters on is written by the spec itself, mid-run, through the file watcher — that
// is the path under test. The one exception is the seed: a row has to be on screen before the first write, or
// there would be no way to tell "never appeared" from "not loaded yet". It is seeded before the server boots
// by playwright.config.ts, in its own workspace.
//
// Nothing here stubs a request. The rule is entered through the sidebar's own filter editor and saved through
// the app's own PUT — never over the API, because the value of the case is that the entry point really works.

/** The rule, in the shape the editor stores: one regex per line, unanchored, case-insensitive. */
const RULE = '-live-worker$';

/** Seeded before boot (playwright.config.ts): the row already in the feed, which round B renames into the rule. */
const SEED = 'live-seed-human';
/** Written mid-run and matching nothing: the positive control for round A. */
const CONTROL = 'live-new-human';
/** Written mid-run in the same burst as the control, and a match: it must not appear at all. */
const MATCHING = 'live-new-live-worker';
/** Written mid-run with no readable name at all, then named into a match. */
const LATE = 'live-late-session';

/** What round B renames the two rows into. Both match RULE. */
const SEED_RENAMED = 'live-seed-live-worker';
const LATE_RENAMED = 'live-late-live-worker';

/** Namespaced i18n keys leak into the UI as literals like "sidebar.sessionFilter" when a translation is missing. */
const UNTRANSLATED_KEY = /\b(?:mainTabs|settings|chat|common|sidebar)\.[a-z][A-Za-z]+\b/;

/** The workspace playwright.config.ts seeds; every transcript this spec writes goes in its directory. */
const LIVE_WORKSPACE_DIR = 'session-filter-live-workspace';

/** Transcripts are keyed by session id, which is how the app addresses a session everywhere else. */
const sessionIdOf = (name: string) => `e2e-${name}`;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const transcriptPath = (dataDir: string, sessionId: string): string =>
  path.join(dataDir, '.claude', 'projects', LIVE_WORKSPACE_DIR, `${sessionId}.jsonl`);

type TranscriptRecord = Record<string, unknown>;

/** The two record shapes the synchronizer reads: an id-bearing turn, and the custom title that names it. */
const turn = (
  sessionId: string,
  workspace: string,
  message: TranscriptRecord,
  extra: TranscriptRecord = {},
): TranscriptRecord => ({
  type: 'user',
  sessionId,
  cwd: workspace,
  timestamp: new Date().toISOString(),
  message,
  ...extra,
});

const customTitle = (sessionId: string, workspace: string, title: string): TranscriptRecord => ({
  type: 'custom-title',
  sessionId,
  cwd: workspace,
  timestamp: new Date().toISOString(),
  customTitle: title,
});

/**
 * Writes a transcript: the file watcher sees a new file, indexes it, and the server broadcasts the upsert.
 *
 * The whole file goes down in one call, so the watcher never reads a half-written transcript.
 */
const writeTranscript = (dataDir: string, workspace: string, sessionId: string, records: TranscriptRecord[]): string => {
  const filePath = transcriptPath(dataDir, sessionId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return filePath;
};

/** Appends a record to a transcript the spec already wrote or seeded. */
const appendTranscript = (filePath: string, record: TranscriptRecord): void => {
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
};

/**
 * How long a watcher-driven change is given to reach the list.
 *
 * The watcher uses native filesystem events where it can and otherwise polls on a 6s floor, and the flush on
 * top of either is debounced (500ms, capped at 2s). 30s clears the poll floor several times over; a healthy
 * run lands in well under a second, because the file's own `add` event is what wakes the watcher here.
 */
const WATCHER_SETTLE_MS = 30_000;

/**
 * The shared startup warm-up, and the bounded navigation guard that answers what it cannot.
 *
 * `warmClientStartup` proves only that this run's Vite dependency optimizer is quiet: a dependency url
 * answering 200 is the entrance, and the returned reading is the proof that the committed `browserHash`
 * held still, so the document below will not be replaced by a late optimizer commit. It cannot stop a
 * HOST-level network change (`net::ERR_NETWORK_CHANGED`) from cutting the in-flight module requests of
 * the first document: ES modules do not retry, so that boot leaves a white page forever and the login
 * form never mounts. `navigateClientBounded` responds to that: it treats "the document did not mount" as
 * a landing that did not arrive, replaces the document with a bounded `page.reload`, and fails by name
 * (with every hop's own evidence) when its 20s deadline is spent — never as a silent success.
 *
 * This spec used to carry a private copy of the warm-up taken from e2e/session-filter.spec.ts. The copy
 * proved the same thing, but it left the first navigation a bare `page.goto('/')`, so the one failure
 * this run actually paid — the login form never appearing because the host cut the first document's
 * module graph — waited out the file watchdog instead of being answered. It now uses the shared module.
 *
 * The two deterministic control arms (default inert; both exit 0 except the second, which ends red):
 *
 *   SESSION_FILTER_LIVE_ABORT_BOOTS=1 npm run test:e2e -- e2e/session-filter-conversations-live.spec.ts
 *     — one interrupted boot; the replay lands, the run stays green and the log says `(attempt 2)`.
 *   SESSION_FILTER_LIVE_ABORT_BOOTS=9 npm run test:e2e -- e2e/session-filter-conversations-live.spec.ts
 *     — every boot the guard can make is interrupted; the run ends red at `#username`, by name, with
 *       the abort's `net::` evidence and the replay-hop count — not the 55s file watchdog.
 */

test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.describe('the Conversations feed under a saved session-name rule', () => {
  let page: Page;
  let dataDir = '';
  let workspace = '';

  /** One row of the recents list, addressed by the session id it links to — never by its rendered title. */
  const conversationRow = (name: string): Locator =>
    page.locator(`[data-testid="recent-conversation-row"][href="/session/${sessionIdOf(name)}"]`);

  /** The project row this spec saves its rule on, scoped by the seeded workspace's own display name. */
  const projectRow = () =>
    page.getByRole('button', { name: new RegExp(`^${escapeRegExp(path.basename(workspace))}`) }).first();

  /** Switches the sidebar's search mode, which is what mounts and unmounts the recents list. */
  const switchMode = async (label: 'Projects' | 'Conversations') => {
    await page.getByRole('button', { name: label, exact: true }).click();
  };

  /**
   * The members of the feed, as the ids their rows point at, sorted.
   *
   * Membership is the property under test; the order the feed renders in is recency, which this run changes
   * on purpose by writing transcripts. Titles are deliberately not compared: the live row and the reloaded
   * row derive a title for a nameless session from different places (the delta carries the stored name, the
   * endpoint falls back to the session id), and neither is what the rule is judged on.
   */
  const memberIds = async (): Promise<string[]> => {
    const hrefs = await page
      .locator('[data-testid="recent-conversation-row"]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('href') ?? ''));
    return hrefs.map((href) => href.replace(/^\/session\//, '')).sort();
  };

  /** Reloads the feed the way a user does — by leaving the mode and coming back — and reads it again. */
  const membersAfterSwitchingAwayAndBack = async (): Promise<string[]> => {
    await switchMode('Projects');
    // The recents list is only mounted in the conversations mode, so its absence is what proves the switch
    // landed before the reload below is asked for. Without this the read could still be the old render.
    await expect(page.locator('[data-testid="recent-conversations-list"]')).toHaveCount(0);
    await switchMode('Conversations');
    await expect(page.locator('[data-testid="recent-conversations-list"]')).toBeVisible({ timeout: 15_000 });
    await expect(conversationRow(CONTROL)).toBeVisible({ timeout: 15_000 });
    return memberIds();
  };

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    dataDir = process.env.QUAY_E2E_DATA_DIR!;
    workspace = path.join(dataDir, LIVE_WORKSPACE_DIR);
    // The seeded transcript is the one row the feed starts with; failing to find it means the seed drifted.
    const seeded = transcriptPath(dataDir, sessionIdOf(SEED));
    if (!fs.existsSync(seeded)) {
      throw new Error(`the seeded transcript ${seeded} is missing — playwright.config.ts seeds it before boot.`);
    }

    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) {
      throw new Error('playwright.config.ts must give this project a baseURL for the startup warm-up to address');
    }
    const warmup = await warmClientStartup(clientUrl, dataDir);

    page = await browser.newPage();

    /**
     * The run's own startup evidence, filled by the page listeners below and read by the guard when the
     * document does not mount. `warmup` is the optimizer reading of THIS run, so a startup failure can
     * report whether the optimizer was quiet rather than leaving that question to the next investigation.
     */
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const requestFailures: RequestFailure[] = [];
    const evidence: ClientStartupEvidence = { pageErrors, consoleErrors, requestFailures, warmup };
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => {
      requestFailures.push({ url: request.url(), failureText: request.failure()?.errorText ?? 'no failure text' });
    });

    /**
     * THE CONTROL SEAM (deterministic, default inert).
     *
     * The failure `navigateClientBounded` responds to — a host-level network change cutting every in-flight
     * module request of one document — is not producible from inside the repository. This seam produces the
     * SAME failure on demand: with `SESSION_FILTER_LIVE_ABORT_BOOTS=<n>` the first `<n>` document boots have
     * their app entry (`/src/main.tsx`) aborted, so the module graph never executes and `#username` never
     * appears. Everything else is untouched.
     *
     *   SESSION_FILTER_LIVE_ABORT_BOOTS=1  ⇒ the replay lands; the run must stay green, log `(attempt 2)`.
     *   SESSION_FILTER_LIVE_ABORT_BOOTS=9  ⇒ no boot inside the guard's deadline lands; the run must end
     *                                       red at `#username`, with `net::` evidence and the replay count.
     *
     * Unset (or ≤ 0) ⇒ this branch never runs: no effect on a normal run. Counted on the ENTRY request,
     * not on navigation events: each document boot asks for `/src/main.tsx` exactly once, while a
     * navigation event is not observable for every reload through the route seam (the document callback
     * fires for the first `goto` only). The route lives on `page.context()` because `browser.newPage()`
     * gives this page its own implicit context.
     */
    const parsedAbortBoots = Number.parseInt(process.env.SESSION_FILTER_LIVE_ABORT_BOOTS ?? '', 10);
    const abortBoots = Number.isInteger(parsedAbortBoots) && parsedAbortBoots > 0 ? parsedAbortBoots : 0;
    let entryBoots = 0;
    await page.context().route('**', (route) => {
      const url = route.request().url();
      if (!/^(wss?|https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url)) return route.abort();
      if (/\/src\/main\.tsx(\?|$)/.test(url) && entryBoots < abortBoots) {
        entryBoots += 1;
        console.log(
          `[e2e] abort-boots: aborting the app entry for document boot ${entryBoots}/${abortBoots} `
          + '(deterministic interrupted-boot control arm)',
        );
        return route.abort();
      }
      return route.continue();
    });

    // Fresh database: create the single account, then finish onboarding.
    await navigateClientBounded(page, '/', '#username', evidence);
    await page.locator('#username').fill('e2euser');
    await page.locator('input[type=password]').nth(0).fill('e2epassword');
    await page.locator('input[type=password]').nth(1).fill('e2epassword');
    await page.getByRole('button', { name: 'Create Account' }).click();
    await page.getByPlaceholder('John Doe').fill('E2E User');
    await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Complete Setup' }).click();

    // Indexing a session auto-registers its project, so the seeded workspace is already a project here —
    // it is created by the boot scan, not over the API and not through the UI, and the sidebar is the proof.
    await expect(projectRow()).toBeVisible({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('a session that arrives matching a saved rule never enters the feed, and one that does not arrives', async () => {
    // The rule is entered through the sidebar's own editor and saved through the app's own PUT.
    await projectRow().getByTitle('Session filter…').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`Session filter · ${path.basename(workspace)}`);
    await page.getByRole('textbox', { name: 'Session filter' }).fill(RULE);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    // Park on the feed, with the rule live on the project it belongs to.
    await switchMode('Conversations');
    await expect(page.locator('[data-testid="recent-conversations-list"]')).toBeVisible({ timeout: 15_000 });
    await expect(conversationRow(SEED)).toBeVisible({ timeout: 15_000 });
    expect(await memberIds()).toContain(sessionIdOf(SEED));

    // ── round A: one burst, four effects ─────────────────────────────────────────────────────────────────
    //
    // Written inside one debounce window, so the watcher's flush carries them together and "the same time
    // window" is a property of the fixture rather than of how the assertions happen to be ordered.
    //
    //   control  — a new transcript matching nothing: it must appear.
    //   matching — a new transcript matching the rule: it must not.
    //   seed     — the row already on screen, renamed into a match: it must leave.
    //   late     — a new transcript with no readable name: it is *not* a match yet, so it must appear here,
    //              and round B names it into one.
    writeTranscript(dataDir, workspace, sessionIdOf(MATCHING), [
      turn(sessionIdOf(MATCHING), workspace, { role: 'user', content: [{ type: 'text', text: 'a worker turn' }] }),
      customTitle(sessionIdOf(MATCHING), workspace, MATCHING),
    ]);
    writeTranscript(dataDir, workspace, sessionIdOf(CONTROL), [
      turn(sessionIdOf(CONTROL), workspace, { role: 'user', content: [{ type: 'text', text: 'a human turn' }] }),
      customTitle(sessionIdOf(CONTROL), workspace, CONTROL),
    ]);
    appendTranscript(transcriptPath(dataDir, sessionIdOf(SEED)), customTitle(sessionIdOf(SEED), workspace, SEED_RENAMED));
    const latePath = writeTranscript(dataDir, workspace, sessionIdOf(LATE), [
      // `isMeta` is a real record shape and the ladder skips it on purpose, so this session has no readable
      // prompt and the app falls back to its own placeholder name. A session whose name is empty is not
      // reachable from disk at all — the ladder always yields the prompt or the placeholder — which is why
      // the literal empty-name case lives in the unit test and this leg is "arrives undecided, named later".
      turn(sessionIdOf(LATE), workspace, { role: 'user', isMeta: true, content: [{ type: 'text', text: 'session metadata' }] }),
      { type: 'assistant', sessionId: sessionIdOf(LATE), cwd: workspace, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } },
    ]);

    // Wait for every effect of the burst that *should* land before judging the one that should not — that
    // is what makes the absence below a reading about the rule and not about the watcher still being busy.
    await expect(conversationRow(CONTROL)).toBeVisible({ timeout: WATCHER_SETTLE_MS });
    await expect(conversationRow(LATE)).toBeVisible({ timeout: WATCHER_SETTLE_MS });
    await expect(conversationRow(SEED)).toHaveCount(0, { timeout: WATCHER_SETTLE_MS });

    // The matching session never entered the feed. Held for a settle window after the burst's other deltas
    // landed, so a delayed insert would still be caught.
    await expect(conversationRow(MATCHING)).toHaveCount(0);
    await page.waitForTimeout(1_500);
    await expect(conversationRow(MATCHING)).toHaveCount(0);
    await expect(conversationRow(CONTROL)).toBeVisible();

    // ── round B: the row that arrived undecided is renamed into the rule ──────────────────────────────────
    appendTranscript(latePath, customTitle(sessionIdOf(LATE), workspace, LATE_RENAMED));
    await expect(conversationRow(LATE)).toHaveCount(0, { timeout: WATCHER_SETTLE_MS });
    await expect(conversationRow(CONTROL)).toBeVisible();

    // ── the live list is the list a reload returns ────────────────────────────────────────────────────────
    //
    // A rename does not change a session's id, so the seed's row is still addressed by the id it was seeded
    // under; what changed is that the rule now hides it. Every id this spec wrote is accounted for here, and
    // the equality below carries the run's other fixtures along without naming them.
    const live = await memberIds();
    expect(live).toContain(sessionIdOf(CONTROL));
    expect(live).not.toContain(sessionIdOf(MATCHING));
    expect(live).not.toContain(sessionIdOf(SEED));
    expect(live).not.toContain(sessionIdOf(LATE));

    expect(await membersAfterSwitchingAwayAndBack()).toEqual(live);

    // A full page reload is the other way the feed is re-read — a fresh document, the server's own list.
    await page.reload();
    await expect(projectRow()).toBeVisible({ timeout: 30_000 });
    await switchMode('Conversations');
    await expect(page.locator('[data-testid="recent-conversations-list"]')).toBeVisible({ timeout: 15_000 });
    await expect(conversationRow(CONTROL)).toBeVisible({ timeout: 15_000 });
    expect(await memberIds()).toEqual(live);

    // No untranslated i18n literal anywhere on the page, the feed included.
    expect(await page.locator('body').innerText()).not.toMatch(UNTRANSLATED_KEY);
  });
});
