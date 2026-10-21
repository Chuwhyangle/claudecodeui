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
 *
 * WHY A BOUNDED REPLAY. The warm-up proves the dependency optimizer is quiet; it cannot stop a
 * HOST-level network change from interrupting the module requests of the document that is loading.
 * A `net::ERR_NETWORK_CHANGED` burst does exactly that with no server fault at all: ES modules do not
 * retry, so a boot whose module graph was cut in flight leaves a white page forever. `navigateClientBounded`
 * therefore treats "the document did not mount" as a landing that did not arrive and REPLACES the
 * document — a bounded `page.reload` — until its deadline is spent. This is NOT a retry that hides a
 * red: a boot that never lands still ends the run here, by name, carrying every attempt's own
 * evidence, inside a budget short enough to finish before a criterion's own timeout.
 *
 * THE TWO DETERMINISTIC CONTROL ARMS. The spec's `context.route('**')` handler honours
 * `VOICE_E2E_ABORT_BOOTS=<n>` by aborting the app entry (`/src/main.tsx`) for the first `<n>` boots:
 *
 *   VOICE_E2E_ABORT_BOOTS=1 node experiments/voice-e2e-harness/run.mjs --sample 402fad85
 *     — one interrupted boot; the replay lands, the run is green and the log says `(attempt 2)`.
 *   VOICE_E2E_ABORT_BOOTS=9 node experiments/voice-e2e-harness/run.mjs --sample 402fad85
 *     — every boot the guard can make is interrupted; the run ends red at `phase=mounted`, by name,
 *       with the abort's `net::` evidence and the replay-hop count in the failure message.
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

/**
 * The bounded-navigation guard's five named budgets.
 *
 * A DEADLINE rather than a replay count, because it is the SUM that has to fit — spelled out here
 * because forgetting this sum is exactly how a sibling criterion shipped a `page.reload` that could
 * never run (`gap-ac228-criterion-startup-guard-cannot-afford-a-replay`):
 *
 *   first hop            NAVIGATION_PROBE_MS   = 5_000
 * + first landing        FIRST_LANDING_MS      = 7_000
 * + replay hop           REPLAY_NAVIGATION_MS  = 4_000
 * + replay landing       REPLAY_LANDING_MS     = 3_000
 *   ─────────────────────────────────────────────────
 *   worst case                                = 19_000  ≤  STARTUP_GUARD_DEADLINE_MS = 20_000
 *
 * so even a first hop that spends its entire bound still leaves a complete replay inside the
 * deadline. The deadline itself is ≤ 20s on purpose: the acceptance gate gives a criterion 60s
 * (`DEFAULT_ACCEPTANCE_TIMEOUT_MS`), and a startup that never lands must fail HERE, by name, with
 * evidence — not be turned into a bare `not-evaluated (timeout)` by the gate.
 */
/** How long the first `page.goto` hop may take to return a document. */
export const NAVIGATION_PROBE_MS = 5_000;
/** How long the first document's own mount point is given to become visible. */
export const FIRST_LANDING_MS = 7_000;
/** How long a replay's `page.reload` hop may take to return a document. */
export const REPLAY_NAVIGATION_MS = 4_000;
/** How long a replay's document is given to mount. Shorter: a replay is a re-ask, not a cold boot. */
export const REPLAY_LANDING_MS = 3_000;
/** The total budget the guard may spend on all hops, replays included. */
export const STARTUP_GUARD_DEADLINE_MS = 20_000;

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
 * One hop of a guarded navigation, with the evidence THAT HOP added.
 *
 * The spec's page-level listeners are deliberately never reset — they are the run's whole history —
 * so the guard snapshots each array at the start of a hop and keeps only the entries that arrived
 * during it. Without this split a replay's failure report would mix the first document's 58 aborted
 * module requests into the reading of the document that replaced it, and nobody could tell which
 * boot actually failed.
 */
export type ClientStartupHop = {
  /** 1 is the criterion's own first navigation; every later value is a replay. */
  attempt: number;
  kind: 'page.goto' | 'page.reload';
  navigationMs: number;
  /** Why the navigation call itself did not return, or `null` when it did. */
  navigationFailure: string | null;
  landingMs: number;
  landed: boolean;
  pageErrors: readonly string[];
  consoleErrors: readonly string[];
  requestFailures: readonly RequestFailure[];
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
 * The one formatted evidence block both startup failures share — the single copy of the wording, so
 * the single-shot primitive and the replay guard cannot drift into two different readings of the
 * same arrays.
 */
const startupEvidenceLines = (
  evidence: Pick<ClientStartupEvidence, 'pageErrors' | 'consoleErrors' | 'requestFailures' | 'warmup'>,
): string =>
  `${listOrNone('pageerror', evidence.pageErrors)}\n`
  + `${listOrNone('console error', evidence.consoleErrors)}\n`
  + `${listOrNone(
    'requestfailed',
    evidence.requestFailures.map((failure) => `${failure.url} — ${failure.failureText}`),
  )}\n`
  + warmupLine(evidence.warmup);

/** One hop's own slice of the run's listeners, indented under its attempt number. */
const hopEvidenceLine = (hop: ClientStartupHop): string => {
  const headline =
    `  attempt ${hop.attempt} (${hop.kind}): navigation ${hop.navigationMs}ms`
    + `${hop.navigationFailure === null ? '' : ` did not return (${hop.navigationFailure})`}`
    + `, landing ${hop.landingMs}ms, landed=${hop.landed}`;
  const added = [
    ...hop.pageErrors.map((value) => `pageerror: ${value}`),
    ...hop.consoleErrors.map((value) => `console error: ${value}`),
    ...hop.requestFailures.map((failure) => `requestfailed: ${failure.url} — ${failure.failureText}`),
  ];
  return added.length === 0
    ? `${headline} — no new page/console/request failures`
    : `${headline}\n${added.map((value) => `    · ${value}`).join('\n')}`;
};

/**
 * Waits for the client's own mount point, and fails with this run's startup evidence instead of a
 * bare locator timeout.
 *
 * The budget is the caller's (the criterion keeps its 30s), but every way of not meeting it ends here:
 * a document that never mounted, a document whose scripts threw, and a document whose module graph was
 * torn out from under it all report the page's text, its pageerrors, its console errors, its failed
 * requests (url + failureText) and the optimizer reading of the run that produced them.
 *
 * This is the SINGLE-SHOT primitive. A criterion whose boot can be interrupted by a host-level
 * network change should use `navigateClientBounded`, which replays the document and reports per hop.
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
    + startupEvidenceLines(evidence),
  );
};

/**
 * The bounded navigation guard: navigate, probe the landing, and REPLAY the document when the landing
 * did not arrive — until `STARTUP_GUARD_DEADLINE_MS` is spent.
 *
 * WHY A REPLAY AND NOT A LONGER WAIT. The failure this responds to is a host-level network change
 * (`net::ERR_NETWORK_CHANGED`) that aborts the in-flight requests of one document's module graph.
 * ES modules do not retry, so waiting longer on the SAME document can never recover; only a fresh
 * document can. One replay is normally enough (the flap lasts milliseconds), and the budget is sized
 * so a fully-spent first hop still leaves a complete replay inside the deadline — see the constant
 * arithmetic above. The guard never returns success on a document that did not land: when the
 * deadline is spent it throws with the page's text, the run's evidence, and a per-hop breakdown that
 * says exactly which boots were interrupted.
 *
 * A navigation call that times out is a landing that did not arrive, not an error of its own: a
 * document that never finishes loading and one that loads without ever mounting are the same failure
 * from here, and both end at the same named error.
 *
 * Every hop is signed into this run's output — `[e2e] client startup: <selector> landed after <ms>ms
 * (attempt N)` — because the replay this guard exists to make has to be READABLE as a replay, not
 * inferred from the source.
 */
export const navigateClientBounded = async (
  page: Page,
  url: string,
  selector: string,
  evidence: ClientStartupEvidence,
): Promise<void> => {
  const startedAt = Date.now();
  const deadline = startedAt + STARTUP_GUARD_DEADLINE_MS;
  const budgetMs = (): number => Math.max(1, deadline - Date.now());
  const hops: ClientStartupHop[] = [];

  for (let attempt = 1; ; attempt += 1) {
    // Snapshot the run's listeners BEFORE this hop: what arrives from here on is this document's
    // evidence, and the earlier boots' entries must never be reported as the replay's readings.
    const marks = {
      pageErrors: evidence.pageErrors.length,
      consoleErrors: evidence.consoleErrors.length,
      requestFailures: evidence.requestFailures.length,
    };
    const first = attempt === 1;
    const kind: ClientStartupHop['kind'] = first ? 'page.goto' : 'page.reload';

    const navigationStartedAt = Date.now();
    const navigationBudget = Math.min(first ? NAVIGATION_PROBE_MS : REPLAY_NAVIGATION_MS, budgetMs());
    let navigationFailure: string | null = null;
    try {
      if (first) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navigationBudget });
      } else {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: navigationBudget });
      }
    } catch (error) {
      navigationFailure = error instanceof Error ? error.message : String(error);
    }
    const navigationMs = Date.now() - navigationStartedAt;

    const landingStartedAt = Date.now();
    const landingBudget = Math.min(first ? FIRST_LANDING_MS : REPLAY_LANDING_MS, budgetMs());
    let landed = false;
    try {
      await page.locator(selector).waitFor({ state: 'visible', timeout: landingBudget });
      landed = true;
    } catch {
      // Not landed: this hop's failure is the replay's trigger, and the deadline decides whether a
      // replay is still affordable. The locator's own timeout text is not carried into the report.
    }
    const landingMs = Date.now() - landingStartedAt;

    const hop: ClientStartupHop = {
      attempt,
      kind,
      navigationMs,
      navigationFailure,
      landingMs,
      landed,
      pageErrors: evidence.pageErrors.slice(marks.pageErrors),
      consoleErrors: evidence.consoleErrors.slice(marks.consoleErrors),
      requestFailures: evidence.requestFailures.slice(marks.requestFailures),
    };
    hops.push(hop);

    if (landed) {
      console.log(
        `[e2e] client startup: ${selector} landed after ${Date.now() - startedAt}ms (attempt ${attempt})`,
      );
      return;
    }

    const replays = attempt - 1;
    const spent = Date.now() >= deadline;
    console.log(
      `[e2e] client startup: ${selector} NOT landed after ${Date.now() - startedAt}ms `
      + `(attempt ${attempt}, ${kind}, ${navigationMs}ms navigation`
      + `${navigationFailure === null ? '' : ' did not return'}, ${landingMs}ms landing, `
      + `${hop.requestFailures.length} requestfailed in this hop, ${replays} replay(s) so far)`
      + (spent ? ' — startup guard deadline spent' : ' — replaying the navigation'),
    );
    if (spent) break;
  }

  const pageText = await readPageText(page);
  const replays = hops.length - 1;
  throw new Error(
    `the client never mounted "${selector}" and the startup guard spent its `
    + `${STARTUP_GUARD_DEADLINE_MS}ms budget after ${hops.length} attempt(s) `
    + `(${replays} replay hop(s); the first hop was bounded by ${NAVIGATION_PROBE_MS}ms navigation plus `
    + `${FIRST_LANDING_MS}ms landing, each replay by ${REPLAY_NAVIGATION_MS}ms plus ${REPLAY_LANDING_MS}ms). `
    + 'The run\'s own startup evidence follows.\n'
    + `document.body.innerText:\n${pageText}\n`
    + startupEvidenceLines(evidence)
    + '\nper-hop evidence (each hop\'s own entries only, so a replay is never read as the first boot):\n'
    + hops.map(hopEvidenceLine).join('\n'),
  );
};
