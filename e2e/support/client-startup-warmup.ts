/**
 * Takes a run's first Vite dependency optimization out of the measurement window, and turns a client
 * that never mounts into this spec's own bounded, self-reporting failure.
 *
 * WHY THIS MODULE EXISTS. Two red runs of `voice-realtime-continuous-experience.spec.ts` on the same
 * tree as seven green ones (AC-361, 2026-10-18) both died one line after the first navigation:
 * `.chat-messages-pane` never appeared, every module request of that run aborted in the same instant,
 * and the page stayed white. The optimizer commits a bundle into the run's private cache *during*
 * the first page load and pushes Vite's `full-reload`; a browser that loses the race is left with a
 * document nothing re-navigates. Sibling criteria (`voice-error-messages`, the upload fixture,
 * `activity-dock-*`) had already paid that cost before `browser.newContext()` — this run had not.
 *
 * WHAT THE WARM-UP PROVES. A dependency url answering 200 is the *entrance*, not the proof: the
 * optimizer can commit again when the entry's own crawl finds a dependency the pre-bundle lacked,
 * and that second commit supersedes the url the first wrote. So the return condition is the
 * optimizer's own `_metadata.json` `browserHash` holding still for `OPTIMIZER_QUIET_WINDOW_MS` — the
 * same fact every dependency url in the served entry carries as `?v=<hash>`, read later in time.
 *
 * WHY THE GUARD. The bare `expect(locator).toBeVisible({ timeout: 30_000 })` reported only
 * `Timeout 30000ms exceeded while waiting for locator(...)`; a gate reading the tail saw `[BABEL]`
 * noise and could not tell an optimizer reload from a server fault from a browser abort. The wait
 * below keeps the same wall-clock budget but fails with the evidence the spec already collects —
 * the page's text, its uncaught errors, its console errors, and every failed request with its
 * `failureText` — plus the warm-up readings of the run that failed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

/** How long this run's client is given to answer its own entry and settle its optimizer. */
export const CLIENT_WARM_DEADLINE_MS = 30_000;
/** How long the optimizer's committed `browserHash` must hold still before the optimizer is settled. */
export const OPTIMIZER_QUIET_WINDOW_MS = 1_000;
/** How often the private cache's commit marker is re-read while proving that quiet. */
export const OPTIMIZER_POLL_MS = 250;

/** A dependency url the optimizer serves out of this run's private cache, as the entry writes it. */
const OPTIMIZED_DEP_IN_TEXT = /["'](\/@fs\/[^"']*\/deps\/[^"']+\.js\?v=[0-9a-f]+)["']/;

/** The optimizer's own record of what it has committed for THIS run's cache — see `committedBrowserHash`. */
const optimizerMetadataPath = (dataDir: string): string => path.join(dataDir, 'vite-cache', 'deps', '_metadata.json');

/**
 * The optimizer's own record of what it has committed for this run's private cache, as one comparable
 * string.
 *
 * `_metadata.json` is written whole, by atomic rename, each time the optimizer commits, and
 * `browserHash` is the field that commit changes: it is the value every dependency url in the served
 * entry carries as `?v=<hash>`. Reading it is therefore reading the same fact a dependency url
 * states, but *later in time* — the url states what was committed when the entry was transformed,
 * while this states what has been committed now.
 *
 * An unreadable file reads as its own distinct string rather than throwing: mid-rename the file can
 * be absent for an instant, and treating that instant as a change only widens the quiet window (the
 * safe direction).
 */
const committedBrowserHash = (dataDir: string): string => {
  try {
    const metadata = JSON.parse(readFileSync(optimizerMetadataPath(dataDir), 'utf8')) as { browserHash?: string };
    return metadata.browserHash ?? '<metadata carried no browserHash>';
  } catch (error) {
    return `<unreadable: ${error instanceof Error ? error.message : String(error)}>`;
  }
};

/**
 * What the warm-up observed, kept so a later startup failure can report the run's own readings rather
 * than a generic timeout. `null` means the warm-up itself failed — the caller then sees its error.
 */
export type ClientWarmupReading = {
  elapsedMs: number;
  /** Whether the optimizer's `browserHash` held for `OPTIMIZER_QUIET_WINDOW_MS`. */
  quiet: boolean;
  /** The dependency url this run's entry named, and what serving it answered. */
  depUrl: string | null;
  depStatus: number | null;
  /** The last committed hash, and every hash change seen while proving quiet. */
  browserHash: string | null;
  browserHashTrace: string[];
};

export type RequestFailure = { url: string; failureText: string };

/**
 * The evidence the spec already collects through its page listeners. Passed by reference: the
 * arrays fill while the page runs, and the guard formats whatever they hold at the moment it fails.
 */
export type ClientStartupEvidence = {
  pageErrors: readonly string[];
  consoleErrors: readonly string[];
  requestFailures: readonly RequestFailure[];
  /** The optimizer reading for this run, or `null` when the warm-up never returned one. */
  warmup: ClientWarmupReading | null;
};

/**
 * Commits this run's Vite dependency pre-bundle before any browser of this run navigates, and returns
 * the readings that prove it.
 *
 * The optimizer is per-run (a private cache directory under the data dir), so its first commit always
 * happens *during* a run; a page that triggers it has its document replaced mid-flight. Doing it here
 * over plain HTTP — the html shell, the app's entry module, and one dependency url current for this
 * run — and then waiting for the committed hash to stop moving means the criterion's first navigation
 * meets a document that stays.
 */
export const warmClientStartup = async (clientUrl: string, dataDir: string): Promise<ClientWarmupReading> => {
  const startedAt = Date.now();
  const deadline = startedAt + CLIENT_WARM_DEADLINE_MS;
  const budgetMs = (): number => Math.max(1, deadline - Date.now());
  const fetchWithin = async (url: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs());
    try {
      return await fetch(url, { signal: controller.signal });
    } catch (error) {
      throw new Error(
        `the client did not answer ${url} inside the ${CLIENT_WARM_DEADLINE_MS}ms startup budget `
        + `(${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * The return condition this warm-up actually needs: the committed `browserHash` holds still for
   * `OPTIMIZER_QUIET_WINDOW_MS`, and only then is the client handed to the criterion.
   *
   * A dependency url that answered 200 is the *entrance* to this check, not its replacement — the url
   * proves a bundle exists, this proves no further one is coming. The window is bounded on both sides
   * by named constants: `OPTIMIZER_QUIET_WINDOW_MS` is how long the hash must persist, and the
   * enclosing `CLIENT_WARM_DEADLINE_MS` is the total budget, so a cache that keeps changing ends in a
   * named error that carries the url, its status, and the hash trace — rather than a warm-up that
   * "succeeded" into a document about to be replaced.
   */
  const awaitOptimizerQuiescence = async (depUrl: string, depStatus: number): Promise<ClientWarmupReading> => {
    const trace: string[] = [];
    let hash = committedBrowserHash(dataDir);
    let quietSince = Date.now();
    trace.push(`+${quietSince - startedAt}ms ${depUrl} HTTP ${depStatus} browserHash=${hash}`);
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(OPTIMIZER_POLL_MS, budgetMs())));
      const now = committedBrowserHash(dataDir);
      if (now !== hash) {
        hash = now;
        quietSince = Date.now();
        trace.push(`+${quietSince - startedAt}ms browserHash=${hash}`);
        continue;
      }
      if (Date.now() - quietSince >= OPTIMIZER_QUIET_WINDOW_MS) {
        const elapsedMs = Date.now() - startedAt;
        console.log(
          `[e2e] client warm-up: ${elapsedMs}ms — optimizer quiet: browserHash=${hash} held `
          + `${OPTIMIZER_QUIET_WINDOW_MS}ms (commits seen ${trace.length})`,
        );
        return { elapsedMs, quiet: true, depUrl, depStatus, browserHash: hash, browserHashTrace: trace };
      }
    }
    throw new Error(
      `the optimizer never went quiet inside the ${CLIENT_WARM_DEADLINE_MS}ms startup budget, so this run cannot `
      + `prove its document will stay: its browserHash had to hold for ${OPTIMIZER_QUIET_WINDOW_MS}ms; the last `
      + `dependency ${depUrl} answered HTTP ${depStatus}; browserHash trace: ${trace.join(' | ')}`,
    );
  };

  const shellUrl = new URL('/', clientUrl).href;
  const shell = await fetchWithin(shellUrl);
  if (!shell.ok) throw new Error(`the client's shell did not load: ${shellUrl} answered HTTP ${shell.status}`);
  await shell.text();

  const entryUrl = new URL('/src/main.tsx', clientUrl).href;
  const entry = await fetchWithin(entryUrl);
  if (!entry.ok) throw new Error(`the app entry did not transform: ${entryUrl} answered HTTP ${entry.status}`);
  await entry.text();

  let lastAnswer = 'no dependency url was ever served';
  for (let attempt = 0; attempt < 5 && Date.now() < deadline; attempt += 1) {
    const specifier = OPTIMIZED_DEP_IN_TEXT.exec(await (await fetchWithin(entryUrl)).text())?.[1];
    if (!specifier) break;
    const depUrl = new URL(specifier, clientUrl).href;
    const dep = await fetchWithin(depUrl);
    if (dep.ok) {
      return awaitOptimizerQuiescence(depUrl, dep.status);
    }
    lastAnswer = `${depUrl} answered HTTP ${dep.status}`;
    await dep.text().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `this run's dependency pre-bundle never committed, so the criterion cannot drive a document that stays: `
    + lastAnswer,
  );
};

/** How much of `document.body.innerText` a failure report carries, and how long reading it may take. */
const PAGE_TEXT_LIMIT = 600;
const PAGE_TEXT_READ_MS = 3_000;

const readPageText = async (page: Page): Promise<string> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const text = await Promise.race([
      page.evaluate(() => (document.body ? document.body.innerText : '')),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('<unreadable: the page did not answer inside 3000ms>'), PAGE_TEXT_READ_MS);
      }),
    ]);
    return text.length > PAGE_TEXT_LIMIT ? `${text.slice(0, PAGE_TEXT_LIMIT)}…` : text;
  } catch (error) {
    return `<unreadable: ${error instanceof Error ? error.message : String(error)}>`;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const listOrNone = (label: string, values: readonly string[]): string =>
  values.length === 0
    ? `${label}: none`
    : `${label} (${values.length}):\n${values.map((value) => `  · ${value}`).join('\n')}`;

const warmupLine = (warmup: ClientWarmupReading | null): string => {
  if (warmup === null) return 'optimizer warm-up: no reading (the warm-up itself threw before returning)';
  return (
    `optimizer warm-up: quiet=${warmup.quiet} after ${warmup.elapsedMs}ms; `
    + `dependency ${warmup.depUrl ?? '(none)'} HTTP ${warmup.depStatus ?? '(none)'}; `
    + `browserHash=${warmup.browserHash ?? '(none)'}; `
    + `browserHash trace: ${warmup.browserHashTrace.join(' | ') || '(none)'}`
  );
};

/**
 * Waits for the client's own mount point, and fails with this run's startup evidence instead of a
 * bare locator timeout.
 *
 * The budget is the caller's (the criterion keeps its 30s), but every way of not meeting it ends here:
 * a document that never mounted, a document whose scripts threw, and a document whose module graph was
 * torn out from under it all report the page's text, its pageerrors, its console errors, its failed
 * requests (url + failureText) and the optimizer reading of the run that produced them.
 */
export const awaitClientMounted = async (
  page: Page,
  selector: string,
  timeoutMs: number,
  evidence: ClientStartupEvidence,
): Promise<void> => {
  try {
    await page.locator(selector).waitFor({ state: 'visible', timeout: timeoutMs });
    return;
  } catch {
    // The locator's own timeout text is deliberately not carried into this error: it names the wait,
    // not the cause, and a gate reading the tail must see the run's evidence instead. See this
    // module's header.
  }

  const pageText = await readPageText(page);
  throw new Error(
    `the client never mounted "${selector}" inside the ${timeoutMs}ms startup budget. `
    + 'The run\'s own startup evidence follows.\n'
    + `document.body.innerText:\n${pageText}\n`
    + `${listOrNone('pageerror', evidence.pageErrors)}\n`
    + `${listOrNone('console error', evidence.consoleErrors)}\n`
    + `${listOrNone(
      'requestfailed',
      evidence.requestFailures.map((failure) => `${failure.url} — ${failure.failureText}`),
    )}\n`
    + warmupLine(evidence.warmup),
  );
};
