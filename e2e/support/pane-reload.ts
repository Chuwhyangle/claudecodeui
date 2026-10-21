/**
 * The reload path's decision window, bounded — and left with room inside it for a replay.
 *
 * WHY THIS MODULE EXISTS. The residual it closes read as an UNREPRODUCIBLE intermittent:
 * `.chat-messages-pane` timing out 30s after a `page.reload()`, `element(s) not found` — the same
 * signature the ledger's reds carry. It is not unreproducible, it is unbounded: the reloaded
 * document's boot requests can be held or interrupted past any window the case is willing to wait.
 * Before the guard a case had one way to spend its window — wait it out, and red — with no second
 * ask in it.
 *
 * WHY IT IS SHARED. The guard first landed in `voice-realtime-upload-fixture.spec.ts` (AC-315,
 * 2026-10-10) and was never carried to `voice-realtime-live-session-send.spec.ts`, whose two
 * historical reloads stayed bare and kept paying the same residual red (2026-10-21 04:02Z, same
 * `:767` signature). Two copies of a replay guard drift; one exported guard is the mechanism.
 *
 * WHAT IT IS NOT. This is not a retry that hides a red. It only replaces the document when the
 * reload itself did not land — exactly what recovers from a document whose boot requests were held
 * or interrupted once — and a run that cannot land still ends HERE, by name, inside this guard's
 * own deadline, with the page's own text.
 */
import type { Page } from '@playwright/test';

/** How long ONE reload hop — the case's own reload and every replay of it alike — is given to return. */
const PANE_RELOAD_HOP_MS = 5_000;
/** How long the FIRST hop's landing is given on its own, before the guard starts replaying. */
const PANE_FIRST_LANDING_MS = 4_000;
/** How long each REPLAY's landing is given. Shorter: a replay is a re-ask, not a cold boot. */
const PANE_REPLAY_LANDING_MS = 3_000;
/**
 * The bound the replay budget is spent out of. A deadline rather than a replay count, because it is the SUM that
 * has to fit — spelled out, because this sum is the whole of why the guard can replay at all:
 *
 *   first hop        PANE_RELOAD_HOP_MS      = 5_000
 * + first landing    PANE_FIRST_LANDING_MS   = 4_000
 * + replay hop       PANE_RELOAD_HOP_MS      = 5_000
 * + replay landing   PANE_REPLAY_LANDING_MS  = 3_000
 *   ───────────────────────────────────────────────
 *   worst case                               = 17_000  ≤  PANE_RELOAD_DEADLINE_MS = 18_000
 *
 * so even a first hop that spends its entire bound still leaves a complete replay inside the deadline, and a
 * run that cannot land ends HERE, by name, with the page's own text — rather than inside the case's own 30s
 * window, where a red says only that a wait ran out.
 */
const PANE_RELOAD_DEADLINE_MS = 18_000;

/** The pane every caller of this guard reads across its reload. */
const PANE = '.chat-messages-pane';

/**
 * A spec's own page narrating failure (`explain(page, what)`): it throws, and its text carries the page's
 * own body text. Passed in rather than re-implemented here so there is exactly one page-text reader per
 * spec and the guard's named failure reads in the spec's own voice.
 */
export type PageExplainer = (page: Page, what: string) => Promise<never>;

/** Whether `locator` showed up within `timeoutMs`. */
const appears = async (locator: ReturnType<Page['locator']>, timeoutMs: number): Promise<boolean> =>
  locator.waitFor({ state: 'visible', timeout: timeoutMs }).then(() => true, () => false);

/**
 * What this replaces: a bare `page.reload()` and then the pane's 30s window. The reload is bounded, the pane
 * it should bring back is probed with a bound of its own, and a probe that does not land has the reload
 * REPLAYED — a fresh document, which is exactly what recovers from a document whose boot requests were held
 * or interrupted once — until the deadline above is spent.
 *
 * One hop's navigation failing is a landing that did not arrive, not an error of its own: a document that never
 * finishes loading and one that loads without ever mounting the session are the same failure from here, and
 * both end at the same named error.
 *
 * Every hop is signed into this run's own output — which hop it is, what it was given, when it returned, and
 * whether the pane came up — because the replay this guard exists to make has to be READABLE in the log as a
 * replay (hop 1 is the case's own reload, every later one is a replay by number), not inferred from the source.
 */
export const reloadPaneBounded = async (page: Page, label: string, explain: PageExplainer): Promise<void> => {
  const startedAt = Date.now();
  const deadline = startedAt + PANE_RELOAD_DEADLINE_MS;
  const budgetMs = () => Math.max(1, deadline - Date.now());
  let navigationFailure: string | null = null;
  for (let attempt = 1; ; attempt += 1) {
    const hopKind = attempt === 1 ? 'page.reload' : `page.reload (replay ${attempt - 1})`;
    const hopBudget = Math.min(PANE_RELOAD_HOP_MS, budgetMs());
    const hopStartedAt = Date.now();
    console.log(`[e2e] reload pane: hop ${attempt} (${hopKind}) begins with ${hopBudget}ms of navigation budget`);
    try {
      await page.reload({ timeout: hopBudget });
      navigationFailure = null;
      console.log(`[e2e] reload pane: hop ${attempt} (${hopKind}) returned after ${Date.now() - hopStartedAt}ms`);
    } catch (error) {
      navigationFailure = error instanceof Error ? error.message : String(error);
      console.log(`[e2e] reload pane: hop ${attempt} (${hopKind}) did not return in ${hopBudget}ms: ${navigationFailure}`);
    }
    const landingBudget = Math.min(attempt === 1 ? PANE_FIRST_LANDING_MS : PANE_REPLAY_LANDING_MS, budgetMs());
    if (await appears(page.locator(PANE), landingBudget)) {
      console.log(`[e2e] reload pane: ${label} came up after ${Date.now() - startedAt}ms (attempt ${attempt}, ${hopKind})`);
      return;
    }
    if (Date.now() >= deadline) {
      await explain(
        page,
        `${label} did not come up within ${Date.now() - startedAt}ms of the reload, replays included`
        + `${navigationFailure === null ? '' : ` (the last navigation did not return either: ${navigationFailure})`}`,
      );
    }
    console.log(`[e2e] reload pane: ${label} was not up ${landingBudget}ms after hop ${attempt} (${hopKind}); replaying the reload`);
  }
};
