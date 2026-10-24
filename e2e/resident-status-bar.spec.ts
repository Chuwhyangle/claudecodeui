/**
 * The resident dock's process panel, its sidebar mark and the panel's two verbs — read off a real
 * browser against a real server, driven by the debug agent's own scenario clock.
 *
 * What this file is *for*. The feature is a surface that describes a process the page does not own:
 * four states, an address, and one row style for a turn nobody typed. Every one of those is a
 * comparison — the sidebar mark against the listing, the address the panel prints against the one
 * the listing publishes, the label against the locale file, the divider against the trigger that
 * produced it — and a comparison is only evidence when both sides were read from somewhere that
 * could have disagreed. So nothing here is asserted against a value this file also wrote: the states
 * come from `GET /api/session-hosts`, the copy comes from the platform clipboard, the labels come
 * from the shipped locale JSON, and the rows come from the transcript the server wrote.
 *
 * Why the debug agent. The alternative is a real `claude` process, and a criterion that needs one is
 * a criterion that cannot run where the binary is absent. `POST /api/debug-agent/clock` walks a
 * scenario instead: the same product chain (provider runtime → host manager → run registry → the
 * normalizer the transcript is read through) with the child process replaced by a scripted clock, so
 * a turn can be opened, held and ended at a moment this file chooses. The gate that mounts that face
 * is opened by `playwright.config.ts` for exactly this file's selection, so no other run's server
 * grows a fixture-writing endpoint.
 *
 * Why the clock is not awaited where it is fired. `POST /clock` blocks for the whole walk — it awaits
 * each step's absolute offset from the run's start. Every reading below therefore happens *while* the
 * walk is in flight, which is the only place the states exist at all: after the response returns, the
 * process has already been walked back to rest. The response is awaited at the end, for the two facts
 * only it carries (which run opened the unattended turn, and whether the seam that opens runs is
 * wired).
 *
 * Two arms, one session each, because the panel's Close and the walk's `exit` cannot both be last:
 * arm A carries the identity, the panel, the copy and the close; arm B carries the walk, the abort
 * and the transcript rows. Splitting them is not a convenience — an arm that both closed a host and
 * expected it to exit would be reading the second half of its own first half.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const LOCALES_ROOT = path.join(REPO_ROOT, 'src/modules/i18n/locales');

/** The locale the page is seeded with, and the one the rendered copy is checked against. */
const LOCALE = 'en';
/** Every locale the shipped keys must be present in — the app's own set, read from disk. */
const ALL_LOCALES = fs.readdirSync(LOCALES_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/** The chat pane, the same anchor transcript-follow uses to know the session actually opened. */
const PANE = '.chat-messages-pane';
/**
 * The resident pill in the workspace header, which opens the process panel.
 *
 * The status bar this file used to address was folded into the dock, and the dock's arrow was then
 * moved out of the message flow into this pill: it is the only way the panel's own facts — the
 * address, the pid and the two verbs — become reachable, and it is drawn for a session whose own host
 * snapshot reads `resident`. The panel is a portal, so it is found by its own root rather than as a
 * descendant of anything. What this criterion measures the process by is still the four-state mark in
 * the sidebar, not the pill's dot (which folds idle and busy into one) and not the dock's activity.
 */
const BAR = '[data-resident-badge]';
const TRIGGER = '[data-resident-badge]';
const PANEL = '[data-resident-panel]';
const PID_TEXT = '[data-resident-pid-text]';
const START = '[data-resident-start]';
const ADDRESS = '[data-resident-address]';
const COPY = '[data-resident-copy]';
const CLOSE = '[data-resident-close]';
const MARK = '[data-resident-mark]';
const DIVIDER = '[data-unattended-divider]';
const UNATTENDED_ROW = '[data-unattended-row]';

/** The account this run creates. Any name works; it is the same one for both arms. */
const USERNAME = 'resident-status-bar-e2e';
const PASSWORD = 'resident-status-bar-e2e-pass';

/** The two sessions' titles, and the address the scenario reports for the process. */
const TITLE_A = 'Resident status bar — popover arm';
const TITLE_B = 'Resident status bar — walk arm';
const PEER_NAME = 'peer-resident-status-bar';
const SEED_USER_TEXT = 'seeded user turn for the resident status bar criterion';

/** The two turns the walk opens unattended, each with the trigger that produced it. */
const CRON_TURN_TEXT = 'unattended turn opened by a scheduled task';
const CROSS_SESSION_TURN_TEXT = 'unattended turn opened by another conversation';

/**
 * Arm A: report the address, then hold the clock open long enough for the popover to be read, the
 * address copied and the process closed. No host step may follow — the close is this arm's last act.
 */
const ARM_A_SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: TITLE_A, userText: SEED_USER_TEXT, lifecycleMode: 'resident' },
  steps: [
    { at: 0, op: 'identity', name: PEER_NAME },
    { at: 5_000, op: 'wait' },
  ],
  expect: { rows: { delta: 0 }, content: { mustContain: [SEED_USER_TEXT] } },
};

/**
 * Arm B: the whole state walk on one clock.
 *
 * Each plateau is wide enough for the status bar's one-second poll to land inside it, and the offsets
 * are absolute from the run's start, so the shape of the walk — and therefore where each reading can
 * be taken — does not depend on how long this file took to get there.
 *
 * The cross-session turn is the one exception, and it is held by a barrier rather than an offset. The
 * reload below lands when the host's own network decides, which can be later than any fixed plateau
 * would allow — a bounded replay is allowed up to `STARTUP_PROBE_DEADLINE_MS` (14s), and the plateau
 * it has to land inside was 6s — so `turn-end` and `exit` sit behind an `await-release` and fire on
 * the reading's own progress instead. The barrier is one-shot (`releaseDebugAgentRun` flips the flag
 * for the whole run), so a single release opens it for every step behind it. `exit` is last because a
 * host that has exited serves no further step.
 */
const ARM_B_SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: TITLE_B, userText: SEED_USER_TEXT, lifecycleMode: 'resident' },
  steps: [
    { at: 0, op: 'identity', name: PEER_NAME },
    { at: 1_000, op: 'unattended-turn', text: CRON_TURN_TEXT, trigger: 'cron' },
    { at: 3_000, op: 'turn-end' },
    { at: 5_000, op: 'keepalive-add', kind: 'monitor' },
    { at: 7_000, op: 'unattended-turn', text: CROSS_SESSION_TURN_TEXT, trigger: 'cross-session', sender: PEER_NAME },
    { at: 8_000, op: 'await-release' },
    { at: 13_000, op: 'turn-end' },
    { at: 14_000, op: 'exit', detail: 'oom' },
    { at: 14_500, op: 'wait' },
  ],
  expect: {
    rows: { delta: 2 },
    content: { mustContain: [CRON_TURN_TEXT, CROSS_SESSION_TURN_TEXT] },
  },
};

/** The four process states and the mark each one draws, as the proposal's §15.1 pins them. */
const MARK_SHAPES: Record<string, string> = {
  unstarted: 'hollow',
  idle: 'solid',
  busy: 'solid+spinner',
  exited: 'exited',
};

/**
 * The word each state is printed with.
 *
 * Kept beside {@link MARK_SHAPES} rather than derived from the host's own vocabulary: this file
 * reports what a reader saw, and the reader's four words are not the host manager's six states.
 */
const STATE_WORD: Record<string, string> = {
  unstarted: '未运行',
  idle: '空闲',
  busy: '运行中',
  exited: 'exited(oom)',
};

// ---------------------------------------------------------------------------------------------
// The wire, read by this file rather than through the page.
//
// Every assertion about the process is made against this listing, and the same listing is what the
// status bar polls — so a bar that rendered a stale or invented state has something to disagree
// with. The two projections below mirror the frontend's own `findLiveHost`/`findSessionHost` rules
// (`src/shared/hooks/useSessionHosts.ts`), which is the point: they are a *second* reading of the
// same rule, and a change to one that the other has not followed shows up as a red here.
// ---------------------------------------------------------------------------------------------

type HostLease = { kind: string; id?: string };
type HostBinding = { appSessionId: string; leases?: HostLease[]; peerName?: string | null };
type HostRecord = {
  hostId: string;
  state: string;
  pid: number | null;
  /**
   * When this host record was opened, as the listing publishes it.
   *
   * Carried because the debug fixture's host has no OS pid: `pid` is the field a
   * real resident process is identified by, and for this driver it is empty, so
   * the reading that a stopped turn left the *same* process behind has to be
   * taken off a field that is actually populated. Two hosts opened by the same
   * test can share a pid of `null`; they cannot share a start stamp.
   */
  startedAt: number | null;
  closeReason: string | null;
  closeDetail: string | null;
  bindings: HostBinding[];
};
type SessionRecord = {
  appSessionId: string;
  provider: string;
  lifecycleMode: string;
  running: boolean;
  reason: string | null;
};

type HostsSnapshot = { hosts: HostRecord[]; sessions: SessionRecord[] };

/** The live host holding one session, or null. Closed hosts are skipped, as the frontend skips them. */
function liveHost(snapshot: HostsSnapshot, sessionId: string): HostRecord | null {
  for (const host of snapshot.hosts) {
    if (host.state === 'closed') continue;
    if (host.bindings.some((binding) => binding.appSessionId === sessionId)) return host;
  }
  return null;
}

/**
 * How many hosts the snapshot reports as still running.
 *
 * Not `hosts.length`: a closed host keeps its record in the listing for a retention window, so the
 * array's own size does not move when a process is closed and a reading taken from it would be a
 * constant. The number that must fall when the user closes a process is this one.
 */
function liveHostCount(snapshot: HostsSnapshot): number {
  return snapshot.hosts.filter((host) => host.state !== 'closed').length;
}

/** The host that most recently served one session, closed or not — the frontend's `findSessionHost`. */
function lastHost(snapshot: HostsSnapshot, sessionId: string): HostRecord | null {
  let found: HostRecord | null = null;
  for (const host of snapshot.hosts) {
    if (host.bindings.some((binding) => binding.appSessionId === sessionId)) found = host;
  }
  return found;
}

/** The session's binding on its live host, or null. */
function liveBinding(snapshot: HostsSnapshot, sessionId: string): HostBinding | null {
  return liveHost(snapshot, sessionId)?.bindings.find((binding) => binding.appSessionId === sessionId) ?? null;
}

/**
 * The UI's word for a host's state.
 *
 * A restatement of `readResidentProcessState` — deliberately a second one. The criterion's whole
 * subject is that the bar and the listing agree about one process, and a check that imported the
 * bar's own rule would agree with the bar by construction, including when both were wrong.
 */
function uiStateOf(host: HostRecord | null): string {
  if (!host) return 'unstarted';
  if (host.state === 'closed') return host.closeReason === 'exited' ? 'exited' : 'unstarted';
  if (host.state === 'busy' || host.state === 'starting') return 'busy';
  return 'idle';
}

// ---------------------------------------------------------------------------------------------
// Locale reading. The copy a reader sees is never written down in this file: it is read from the
// shipped JSON and substituted into, so a criterion cannot pass against a sentence only it knows.
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** Reads one shipped locale file. `null` when it, or the key path, is absent. */
function readLocaleFile(locale: string, file: string): Json | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(LOCALES_ROOT, locale, file), 'utf8')) as Json;
  } catch {
    return null;
  }
}

/** One dot-path inside a parsed locale file, or `undefined`. */
function readKey(source: Json | null, keyPath: string): unknown {
  let node: unknown = source;
  for (const segment of keyPath.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Json)[segment];
  }
  return node;
}

/** Substitutes `{{name}}` placeholders, the way i18next's default interpolation does. */
function render(template: string, params: Record<string, string> = {}): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => params[name] ?? '');
}

const chatLocale = (locale: string) => readLocaleFile(locale, 'chat.json');

// ---------------------------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------------------------

/**
 * Opens the resident panel from the header pill if it is shut, and leaves it open.
 *
 * The panel is mounted only while the pill says so, so every reading of the process's own
 * facts — the address, the pid — begins here. Idempotent by design: a caller that opened the panel
 * itself (arm A) must see its own click open one, not have this helper toggle it shut.
 */
async function openPanel(page: Page): Promise<void> {
  const trigger = page.locator(TRIGGER);
  await trigger.waitFor({ state: 'visible', timeout: 15_000 });
  if ((await trigger.getAttribute('aria-expanded')) === 'true') {
    return;
  }
  await trigger.click();
  await page.locator(PANEL).waitFor({ state: 'attached', timeout: 10_000 });
}

/**
 * The pid line, as the panel prints it.
 *
 * The only process fact this file still reads off the panel: what the process *is* — the four states —
 * is the sidebar mark's, and the dock's own `data-activity-state` answers a different question.
 */
async function readPanel(page: Page): Promise<{ pid: string }> {
  await openPanel(page);
  return { pid: (await page.locator(PID_TEXT).innerText()).trim() };
}

/** The sidebar's mark for one session: its shape, its state and the exit detail when it has one. */
async function readMark(page: Page, sessionId: string) {
  const mark = page.locator(`a[href="/session/${sessionId}"]:not([data-mode-switch-link])`).first().locator(MARK);
  await mark.waitFor({ state: 'attached', timeout: 15_000 });
  return {
    shape: (await mark.getAttribute('data-resident-mark')) ?? '',
    state: (await mark.getAttribute('data-resident-state')) ?? '',
    detail: (await mark.getAttribute('data-resident-exit-detail')) ?? '',
  };
}

/** Fails with what the page actually held, rather than with a locator timeout and nothing else. */
async function explain(page: Page, what: string): Promise<never> {
  const body = await page.locator('body').innerText().catch(() => '<unreadable>');
  throw new Error(`${what}; the page held:\n${body.slice(0, 2_000)}`);
}

/**
 * The project row's toggle, whose accessible name starts with the workspace's directory name.
 *
 * The sidebar's own control, clicked rather than bypassed: a session row only exists once its
 * project is expanded, and expanding it any other way would leave the row this file reads not
 * necessarily the row a user would see.
 */
const projectRow = (page: Page, workspaceName: string): Locator =>
  page.getByRole('button', { name: new RegExp(`^${workspaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first();

const sessionRow = (page: Page, sessionId: string): Locator => page.locator(`a[href="/session/${sessionId}"]:not([data-mode-switch-link])`).first();

/** The sidebar mark for one session, as a locator — the row a four-state wait is addressed through. */
const markOf = (page: Page, sessionId: string): Locator => sessionRow(page, sessionId).locator(MARK);

/** Expands the fixture project until the session's row is on screen. Bounded, and never silent. */
async function revealSession(page: Page, workspaceName: string, sessionId: string): Promise<void> {
  const row = sessionRow(page, sessionId);
  await projectRow(page, workspaceName).waitFor({ state: 'visible', timeout: 30_000 });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await row.isVisible().catch(() => false)) return;
    await projectRow(page, workspaceName).click().catch(() => undefined);
    if (await row.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false)) return;
  }
  await explain(page, `the sidebar never showed a row for session ${sessionId}`);
}

/**
 * Records every frame the chat socket receives, for the life of the page.
 *
 * The abort's outcome reaches this client as a terminal frame and nowhere else: the REST listing has
 * no field for it, and the run registry that does is not exposed over HTTP. Installing a subclass
 * rather than re-assigning `onmessage` keeps the app's own handlers working — the recorded frames
 * are copies of what the app already got.
 */
const recordSocketFrames = () => {
  const page = window as unknown as { __socketFrames: unknown[] };
  page.__socketFrames = [];
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      this.addEventListener('message', (event: MessageEvent) => {
        try {
          page.__socketFrames.push(JSON.parse(String((event as MessageEvent).data)));
        } catch {
          // A binary or non-JSON frame is not part of this protocol; nothing to record.
        }
      });
    }
  } as unknown as typeof WebSocket;
};

const socketFrames = (page: Page): Promise<Array<Record<string, unknown>>> =>
  page.evaluate(() => (window as unknown as { __socketFrames: Array<Record<string, unknown>> }).__socketFrames ?? []);

// ── the startup guard ────────────────────────────────────────────────────────────────────────────────────────
//
// This spec's startup path, bounded. Measured: a page-period Vite dependency pre-bundle (a cold re-optimize this
// run's own `vite-cache/deps` had to build after `seedViteCache()` silently degraded) holds every in-flight module
// request until it commits and then pushes `full-reload`, which replaces the document whole. The module graph never
// finished executing — `ThemeContext.tsx`, the module barrels, `i18n/config.ts` and the rest were still in flight
// (response status -1) when the trace was cut, no `/api/*` was ever requested, React never mounted and the fixture
// project row never appeared. The only wait on that row was `revealSession`'s unbounded
// `waitFor({ state: 'visible', timeout: 30_000 })`: the run died at 30s with `TimeoutError: locator.waitFor:
// Timeout 30000ms exceeded`, not one of the four cases having run.
//
// The trigger (this run's own dependency optimization) is decided by the cache, not by this file. What is inside it
// is the *response*: the same interruption must cost a bounded replay, not an unbounded wait. Two levers, both
// already established in this repo's sibling specs — a bounded client warm-up and a bounded navigation probe, taken
// from `e2e/resident-running-view.spec.ts` and the `session-filter` / `transcript-follow` pair. Neither is invented
// here.
//
// What the guard may **not** do is decide anything for the four cases. It replays a navigation and it fails loudly
// when it cannot land; it never treats "not landed" as "good enough". Written the other way — probe times out,
// carry on — the four cases would each wait out their own budget on a blank document and the run would still cross
// the gate's 60s, which is what the bounded-failure reading in this task's AC measures.

/** A dependency the optimizer serves out of this run's private cache, already rewritten to its url. */
const OPTIMIZED_DEP_IN_TEXT = /["'](\/@fs\/[^"']*\/deps\/[^"']+\.js\?v=[0-9a-f]+)["']/;

/**
 * How long this run's own client is given to answer its app entry before the startup path gives up on it.
 *
 * The run already has two ceilings above it (playwright.config.ts's watchdog, then the goal gate's 60s) and both
 * are *outside* this spec — an unbounded wait here would be reported by whichever fired first, naming neither the
 * url nor the status.
 */
const CLIENT_WARM_DEADLINE_MS = 30_000;

/**
 * Takes this run's first dependency optimization out of the measurement window: the html shell, the app's entry
 * module, and then one optimized dependency — all requested against this run's own client before any page of this
 * run exists.
 *
 * The dependency request is the one that carries the proof, and it is why the step is not just "warm the cache".
 * The imports of a transformed module are already rewritten to this run's own
 * `/@fs/<cacheDir>/deps/<dep>.js?v=<hash>` urls, and that url only answers 200 once the optimizer has committed
 * the bundle: while the bundle is still being built the request is held, and a url carrying a hash from a
 * superseded run is exactly what a page receives `504 Outdated Optimize Dep` for. Vite answers a re-optimization
 * committed after it began serving by pushing `full-reload` to every connected client, which replaces the document
 * whole — the way this criterion has lost a page mid-flight. A 200 there means the page below will not race the
 * optimizer.
 *
 * `beforeAll`, before `browser.newContext()`/`newPage()`, is the earliest point inside the criterion's own startup
 * path, and it is strictly before any page exists — the same requests the page would have made, made first. It is
 * here rather than in playwright.config.ts's `globalSetup` because Playwright resolves every `globalSetup` entry as
 * a *script* (a path that must default-export the function), so an inline warm-up there is neither type-legal nor
 * loadable, and this task's write surface allows no new file.
 *
 * Every step is bounded, including each request: a client that accepts the connection and then never answers fails
 * here, by name, with the url and the status, rather than waiting out a timeout further up.
 */
const warmClientStartup = async (clientUrl: string): Promise<number> => {
  const startedAt = Date.now();
  const deadline = startedAt + CLIENT_WARM_DEADLINE_MS;
  const budgetMs = () => Math.max(1, deadline - Date.now());
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

  const shellUrl = new URL('/', clientUrl).href;
  const shell = await fetchWithin(shellUrl);
  if (!shell.ok) throw new Error(`the client's shell did not load: ${shellUrl} answered HTTP ${shell.status}`);
  await shell.text();

  const entryUrl = new URL('/src/main.tsx', clientUrl).href;
  const entry = await fetchWithin(entryUrl);
  if (!entry.ok) throw new Error(`the app entry did not transform: ${entryUrl} answered HTTP ${entry.status}`);
  await entry.text();

  // The proof: a dependency url current for this run — re-read from the entry each attempt, because the hash a url
  // carries is the one its writer committed, and the entry is where the current one is written.
  let lastAnswer = 'no dependency url was ever served';
  for (let attempt = 0; attempt < 5 && Date.now() < deadline; attempt += 1) {
    const specifier = OPTIMIZED_DEP_IN_TEXT.exec(await (await fetchWithin(entryUrl)).text())?.[1];
    if (!specifier) break;
    const depUrl = new URL(specifier, clientUrl).href;
    const dep = await fetchWithin(depUrl);
    if (dep.ok) {
      console.log(`[e2e] client warm-up: pre-bundle committed in ${Date.now() - startedAt}ms`);
      return Date.now() - startedAt;
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

/** Whether `locator` showed up within `timeoutMs`. */
const appears = async (locator: Locator, timeoutMs: number): Promise<boolean> =>
  locator.waitFor({ state: 'visible', timeout: timeoutMs }).then(
    () => true,
    () => false,
  );

/** How long the landing of the *first* navigation is given on its own, before the guard starts replaying. */
const STARTUP_PROBE_MS = 8_000;
/** How long each bounded replay's landing is given. Shorter than the first: a replay is a re-ask, not a cold boot. */
const STARTUP_RELOAD_PROBE_MS = 3_000;
/** How long one navigation's single rpc to its server is given, before the guard treats it as a failed landing. */
const NAVIGATION_PROBE_MS = 8_000;

/**
 * How long the startup probe may spend proving a navigation landed, replays included.
 *
 * A deadline rather than a replay count, because it is the *sum* that has to stay inside the criterion's own wall
 * clock: the bounded-failure reading asks that a probe which cannot succeed ends the whole run in under 30s, and
 * that run pays the config evaluation, both servers' boot and the browser launch before the probe's first attempt
 * even starts. Counting replays leaves that head-room to chance; a deadline spends it.
 */
const STARTUP_PROBE_DEADLINE_MS = 14_000;

/**
 * What the startup page said, kept for one purpose: a startup red has to *explain* a document that was pulled out
 * from under the navigation instead of reporting that a wait ran out.
 */
const startupEvidence = {
  consoleErrors: [] as string[],
  failedRequests: [] as string[],
};

/** The startup page's own text plus this run's console and network evidence — what a startup red is read from. */
const readStartupEvidence = async (page: Page): Promise<string> => {
  const shown = await page.locator('body').innerText().catch(() => '<unreadable>');
  const errors = startupEvidence.consoleErrors.slice(0, 5);
  const failed = startupEvidence.failedRequests.slice(0, 5);
  return `the page shows ${JSON.stringify(shown.slice(0, 300))}`
    + `; console errors: ${errors.length > 0 ? errors.join(' | ') : '<none>'}`
    + `; failed requests: ${failed.length > 0 ? failed.join(' | ') : '<none>'}`;
};

/**
 * What a guarded navigation is expected to land on — and how the guard names it when it never lands.
 *
 * `present` and `label` are functions rather than values because both are read at attempt time: the label carries
 * the run's own workspace, and the locator has to be re-created against whatever document is current *now*, after
 * a replay has replaced the one the navigation started on.
 */
type StartupLanding = {
  /** Names this landing in the guard's own error, so a red says which document never came up. */
  readonly label: () => string;
  /** Whether the landing is on screen right now, within `budgetMs`. */
  readonly present: (budgetMs: number) => Promise<boolean>;
};

/**
 * The one place this spec makes a navigation whose landing it has to wait on: the startup load (`kind: 'first-load'`)
 * and the two deliberate reconnects further down (`kind: 'replay'`). The reconnects are readings taken from a
 * document that started from nothing, and they are held to the same bound for the same reason — a document pulled
 * out from under a navigation must end the run here, with a cause, rather than let the case below time out on a
 * page that never mounted.
 *
 * One pass is: navigate, then probe the landing with a short budget. A landing that does not arrive has the
 * navigation replayed — a fresh document, which is exactly what recovers from in-flight module requests that were
 * interrupted once — and the probe repeated, until the deadline. When the deadline is spent the guard throws with
 * the page's own text and this run's failed-request list, never silently continuing: a probe that cannot land must
 * end the run here, with a cause, rather than let four cases time out one after another on a document with nothing
 * in it.
 *
 * The navigation itself is bounded too, and a navigation that times out is treated as a landing that did not
 * arrive rather than as an error of its own — a document that never finishes loading and a document that loads
 * without ever mounting are the same failure from here, and both end at the same named error.
 */
const navigateBounded = async (
  page: Page,
  landing: StartupLanding,
  kind: 'first-load' | 'replay',
): Promise<void> => {
  const startedAt = Date.now();
  const deadline = startedAt + STARTUP_PROBE_DEADLINE_MS;
  const budgetMs = () => Math.max(1, deadline - Date.now());
  let navigationFailure: string | null = null;
  for (let attempt = 1; ; attempt += 1) {
    try {
      if (attempt === 1 && kind === 'first-load') {
        await page.goto('/', { timeout: Math.min(NAVIGATION_PROBE_MS, budgetMs()) });
      } else {
        await page.reload({ timeout: Math.min(NAVIGATION_PROBE_MS, budgetMs()) });
      }
      navigationFailure = null;
    } catch (error) {
      navigationFailure = error instanceof Error ? error.message : String(error);
    }
    const landingBudget = Math.min(attempt === 1 ? STARTUP_PROBE_MS : STARTUP_RELOAD_PROBE_MS, budgetMs());
    if (await landing.present(landingBudget)) {
      console.log(
        `[e2e] client startup: ${landing.label()} landed after ${Date.now() - startedAt}ms (attempt ${attempt})`,
      );
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${landing.label()} never rendered, so this run's client never came up to a document that stays`
        + `${navigationFailure === null ? '' : ` (the navigation itself failed: ${navigationFailure})`}`
        + `: ${await readStartupEvidence(page)}`,
      );
    }
  }
};

// ---------------------------------------------------------------------------------------------
// Setup.
// ---------------------------------------------------------------------------------------------

/**
 * An account this run owns, created over the API.
 *
 * The onboarding wizard is a three-screen flow that exists to collect a display name and an email,
 * neither of which this criterion reads; driving it would spend a third of the run's budget on
 * screens the subject never appears in. The profile flag it sets is the only thing the app checks
 * afterwards, so it is set here through the same endpoint the wizard's last screen calls.
 */
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

/** Arms one scenario and returns the ids the rest of this file addresses it by. */
async function armScenario(
  api: APIRequestContext,
  projectPath: string,
  scenario: unknown,
): Promise<{ sessionId: string; transcriptPath: string }> {
  const response = await api.post('/api/debug-agent/scenarios', { data: { projectPath, scenario } });
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`arming failed (${response.status()}): ${JSON.stringify(body)}`);
  }
  const data = body?.data;
  if (typeof data?.sessionId !== 'string') {
    throw new Error(`arming returned no sessionId: ${JSON.stringify(body)}`);
  }
  return { sessionId: data.sessionId, transcriptPath: data.transcriptPath };
}

test.describe.configure({ mode: 'serial' });

test.describe('resident status bar', () => {
  let page: Page;
  let api: APIRequestContext;
  let workspace = '';
  let workspaceName = '';
  let armA = '';
  let armB = '';

  test.beforeAll(async ({ browser }) => {
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');
    const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
    if (!fixtureHome) {
      throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME for the debug agent selection');
    }
    if (!process.env.QUAY_E2E_RUN_STARTED_AT) {
      throw new Error('playwright.config.ts must publish QUAY_E2E_RUN_STARTED_AT for the elapsed reading');
    }

    // The workspace has to sit inside the fixture home: the control plane writes only under
    // `DEBUG_AGENT_HOME` and refuses a `projectPath` outside it. The transcript it arms lands under
    // that home's `.claude/projects`, which is a tree of the debug provider's own — no other
    // provider's scan reads it, so the row stays the one the debug synchronizer wrote.
    workspace = path.join(fixtureHome, 'resident-status-bar-workspace');
    workspaceName = path.basename(workspace);

    // The account is created on a context of its own, and every read below runs on a context that
    // carries its token: both faces this file reads — the host listing and the debug agent's
    // control plane — are mounted behind the same `authenticateToken` as the rest of `/api`, so an
    // anonymous request is answered with a refusal rather than with the state.
    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();
    api = await request.newContext({
      baseURL: clientUrl,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });

    armA = (await armScenario(api, workspace, ARM_A_SCENARIO)).sessionId;
    armB = (await armScenario(api, workspace, ARM_B_SCENARIO)).sessionId;

    // What the two armed sessions are stored as, before anything is started. Printed rather than
    // assumed: the `[启动]` control resolves its host driver from `session.provider`, so a row that
    // named a different provider than the one that armed it would be refused by a driver belonging
    // to someone else — and the refusal would arrive as a state, not as an error a reader could
    // attribute.
    for (const session of (await readHosts(api)).sessions) {
      if (session.appSessionId !== armA && session.appSessionId !== armB) continue;
      console.log(
        `armed.session=${session.appSessionId} provider=${session.provider} `
        + `lifecycleMode=${session.lifecycleMode} running=${String(session.running)}`,
      );
    }

    // Before any page of this run exists, so this run's optimize/re-optimize is over before the guard's first
    // navigation — see the helper for why the cost cannot be left inside the measurement window.
    await warmClientStartup(clientUrl);

    const context = await browser.newContext({ baseURL: clientUrl });
    // Read and written by this criterion only; granted here rather than at the click so a refusal is
    // this run's own, named at setup, instead of a silent empty string later.
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: clientUrl });
    await context.addInitScript(
      ({ key, value, language }: { key: string; value: string; language: string }) => {
        window.localStorage.setItem(key, value);
        window.localStorage.setItem('userLanguage', language);
      },
      { key: 'auth-token', value: token, language: LOCALE },
    );
    await context.addInitScript(recordSocketFrames);

    page = await context.newPage();
    // What the page said, kept for one purpose: the startup guard has to be able to *explain* a document that was
    // pulled out from under a navigation instead of reporting that a wait ran out. Registered before the first
    // navigation, or the interruption that matters would not be in the evidence.
    page.on('console', (message) => {
      if (message.type() === 'error') {
        startupEvidence.consoleErrors.push(message.text());
        console.log(`[e2e] page console error: ${message.text()}`);
      }
    });
    page.on('requestfailed', (request) => {
      startupEvidence.failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? 'no error text'}`);
    });

    // The first navigation this spec makes is the guard's — it lands on the fixture project row or it ends
    // the run with the page's own text and this run's failed-request list. `revealSession` below then expands the
    // row. The two deliberate reloads further down are reconnects and go through the same guard (see their own
    // comments).
    const projectRowLanding: StartupLanding = {
      label: () => `the project row for ${workspaceName}`,
      present: (budgetMs) => appears(projectRow(page, workspaceName), budgetMs),
    };
    await navigateBounded(page, projectRowLanding, 'first-load');
    // The sidebar is the proof the account and the fixture project both landed.
    await revealSession(page, workspaceName, armA);
  });

  test.afterAll(async () => {
    await page?.close();
    await api?.dispose();
  });

  /**
   * The address, the copy and the close — arm A.
   *
   * Ordered so the close is the last thing that happens to arm A's host: its address can only be read
   * once the scenario has reported one, and its mark can only be read as "hollow" once the host is
   * gone. Both are read through the surfaces a user reads — the dock panel's own text and the
   * sidebar's mark — while the values they are compared against come from the listing this page also
   * polls.
   */
  test('the popover reports the address the listing publishes, copies it, and closes the process', async () => {
    await revealSession(page, workspaceName, armA);
    await sessionRow(page, armA).click();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    // The pill is the resident-only positive signal: it draws for a session its own host snapshot
    // reads `resident`, the same gate the panel body uses.
    await expect(page.locator(BAR)).toBeVisible({ timeout: 30_000 });
    await openPanel(page);

    // Start through the panel's own control, so the state this arm walks into is one the product
    // produced rather than one this file wrote. The four-state reading is the sidebar mark's now.
    const beforeStart = await readMark(page, armA);
    expect(beforeStart.state, 'a resident session with no host must read as not running').toBe('unstarted');
    await page.locator(START).click();
    await expect(markOf(page, armA)).toHaveAttribute('data-resident-state', 'idle', { timeout: 15_000 });

    const started = await readMark(page, armA);
    const snapshotAtStart = await readHosts(api);
    const startState = uiStateOf(lastHost(snapshotAtStart, armA));
    console.log(
      `state=${STATE_WORD[started.state]} mark=${MARK_SHAPES[started.state]} `
      + `snapshot.state=${liveHost(snapshotAtStart, armA)?.state ?? 'absent'} closeReason= detail= via=start`,
    );
    expect(started.state, 'the mark and the listing must agree about the started process').toBe(startState);
    expect(started.shape, 'the mark draws the shape §15.1 pins for this state').toBe(MARK_SHAPES.idle);

    // Fired without awaiting: the walk blocks until its last offset, and the panel is read while it
    // is in flight. Awaiting here would mean reading a state the walk had already left.
    // Reduced to a settled value rather than left as a bare promise: if an assertion below fails
    // while the walk is still in flight, `afterAll` disposes the request context under it, and a
    // promise left dangling here would report *that* as this test's error instead of the real one.
    const clockA = api
      .post('/api/debug-agent/clock', { data: { sessionId: armA } })
      .then(async (response) => ({
        ok: response.ok(),
        status: response.status(),
        body: (await response.json().catch(() => null)) as { success?: boolean } | null,
      }))
      .catch((error: unknown) => ({ ok: false, status: -1, body: { failed: String(error) } }));

    // The panel was opened above and stays open; the scenario's identity step runs at the walk's own
    // zero, so the address arrives with it.
    await expect(page.locator(ADDRESS)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(ADDRESS)).not.toBeEmpty({ timeout: 10_000 });

    const address = (await page.locator(ADDRESS).innerText()).trim();
    const snapshotAtAddress = await readHosts(api);
    const peerName = liveBinding(snapshotAtAddress, armA)?.peerName ?? null;
    console.log(
      `panel.address=${JSON.stringify(address)} snapshot.peerName=${JSON.stringify(peerName)} `
      + `equal=${String(address === peerName && address.length > 0)}`,
    );
    expect(address, 'the panel must show the address the listing publishes, not a second one').toBe(peerName);
    expect(address.length, 'an empty address would make the equality above vacuous').toBeGreaterThan(0);

    await page.locator(COPY).click();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    console.log(
      `copy.clipboard=${JSON.stringify(clipboard)} equalToAddress=${String(clipboard === address)}`,
    );
    expect(clipboard, 'Copy must put the address it displays on the clipboard').toBe(address);

    // Let the walk finish before the close. Closing a host is what ends the scenario, and a walk cut
    // off at offset 4 of 6 never reports a reading — the `/clock` call would answer 500
    // `DEBUG_AGENT_RUN_READING_MISSING`, which is a reading about this file's ordering rather than
    // about the product. The process is still live afterwards: the walk's own turn ends at 5000 and a
    // resident host is meant to sit there between turns, so the close below is still closing a
    // running process.
    const clockABody = await clockA;
    expect(clockABody.ok, `arm A's clock walk must complete: ${JSON.stringify(clockABody)}`).toBe(true);
    expect(clockABody.body?.success, `arm A's walk must report success: ${JSON.stringify(clockABody.body)}`).toBe(true);

    // The positive control for the close below: the same host id must be present *before* it is
    // closed, or "the count went down" would also be satisfied by a host that was never there.
    const snapshotBeforeClose = await readHosts(api);
    const hostBeforeClose = liveHost(snapshotBeforeClose, armA);
    console.log(`host.present=${String(hostBeforeClose !== null)} host.id=${hostBeforeClose?.hostId ?? '(none)'}`);
    expect(hostBeforeClose, 'the panel was opened over a process, so a live host must exist').not.toBeNull();

    const [closeResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith(`/api/session-hosts/${armA}/close`)),
      page.locator(CLOSE).click(),
    ]);
    const snapshotAfterClose = await readHosts(api);
    console.log(
      `close.request=${closeResponse.status()} hosts.beforeClose=${liveHostCount(snapshotBeforeClose)} `
      + `hosts.afterClose=${liveHostCount(snapshotAfterClose)}`,
    );
    expect(closeResponse.status(), 'closing a live host is accepted').toBeLessThan(300);
    expect(
      liveHostCount(snapshotAfterClose),
      'closing the process must leave one fewer host running',
    ).toBeLessThan(liveHostCount(snapshotBeforeClose));
    // The record itself, as well as the count: a close that removed the host from the listing would
    // satisfy the line above while throwing away the reason it ended.
    expect(
      liveHost(snapshotAfterClose, armA),
      'the host the user closed must stop being a live host for its session',
    ).toBeNull();
    expect(
      lastHost(snapshotAfterClose, armA)?.state,
      'the closed host must be recorded as closed, not dropped from the listing',
    ).toBe('closed');
    expect(
      lastHost(snapshotAfterClose, armA)?.closeReason,
      'the record must say the user is why it closed',
    ).toBe('user');

    await expect(markOf(page, armA)).toHaveAttribute('data-resident-state', 'unstarted', { timeout: 15_000 });
    const closed = await readMark(page, armA);
    console.log(
      `state=${STATE_WORD[closed.state]} mark=${MARK_SHAPES[closed.state]} mark.afterClose=${closed.shape} `
      + `snapshot.state=${lastHost(snapshotAfterClose, armA)?.state ?? 'absent'} `
      + `closeReason=${lastHost(snapshotAfterClose, armA)?.closeReason ?? '(none)'} detail= via=close`,
    );
    expect(closed.state, 'a process the user closed is back to not running').toBe('unstarted');
    expect(closed.shape, 'the mark for a session nobody started is the hollow one').toBe(MARK_SHAPES.unstarted);
  });

  /**
   * The state walk, the abort and the unattended rows — arm B.
   *
   * One clock carries all four readings because they are four views of one process: the state is what
   * the host's lease set derives, the abort is what happens to one of those leases, and the rows are
   * what the turns that held them wrote.
   */
  test('the walk drives all four states, and stopping leaves the process', async () => {
    await revealSession(page, workspaceName, armB);
    await sessionRow(page, armB).click();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(BAR)).toBeVisible({ timeout: 30_000 });
    await openPanel(page);

    await page.locator(START).click();
    await expect(markOf(page, armB)).toHaveAttribute('data-resident-state', 'idle', { timeout: 15_000 });

    // Every debug-agent response this run sees, so the seam reading below counts what the wire said
    // rather than what this file expected it to say.
    const controlPlaneTraffic: string[] = [];
    const recordTraffic = (response: { url(): string; text(): Promise<string> }) => {
      if (response.url().includes('/api/debug-agent/')) {
        void response.text().then((text) => controlPlaneTraffic.push(text), () => undefined);
      }
    };
    page.on('response', recordTraffic);

    const clockB = api
      .post('/api/debug-agent/clock', { data: { sessionId: armB } })
      .then(async (response) => ({
        ok: response.ok(),
        status: response.status(),
        body: (await response.json().catch(() => null)) as
          | { success?: boolean; data?: { runSource?: string | null } }
          | null,
      }))
      .catch((error: unknown) => ({ ok: false, status: -1, body: { failed: String(error) } }));

    // --- the first turn opens: 运行中 ------------------------------------------------------------
    await expect(markOf(page, armB)).toHaveAttribute('data-resident-state', 'busy', { timeout: 10_000 });
    const busy = await readMark(page, armB);
    const snapshotBusy = await readHosts(api);
    const busyHost = liveHost(snapshotBusy, armB);
    console.log(
      `state=${STATE_WORD[busy.state]} mark=${MARK_SHAPES[busy.state]} `
      + `snapshot.state=${busyHost?.state ?? 'absent'} closeReason= detail= via=scenario-step`,
    );
    expect(busy.state, 'a turn in flight is the running state').toBe('busy');
    expect(busy.state, 'the mark and the listing must agree while a turn is in flight').toBe(uiStateOf(busyHost));
    expect(busy.shape, 'the mark is the shape §15.1 pins for this state').toBe(MARK_SHAPES.busy);

    // --- the turn ends: 空闲 -----------------------------------------------------------------
    await expect(markOf(page, armB)).toHaveAttribute('data-resident-state', 'idle', { timeout: 10_000 });
    const idle = await readMark(page, armB);
    const snapshotIdle = await readHosts(api);
    console.log(
      `state=${STATE_WORD[idle.state]} mark=${MARK_SHAPES[idle.state]} `
      + `snapshot.state=${liveHost(snapshotIdle, armB)?.state ?? 'absent'} closeReason= detail= via=scenario-step`,
    );
    expect(idle.state, 'the mark and the listing must agree between turns').toBe(uiStateOf(liveHost(snapshotIdle, armB)));

    // The page is reloaded here, and only for this: a document open before the run started was never
    // attached to it, and an unattached socket is never told how the run ended. Reloading subscribes
    // to a run already in flight, which is exactly the state a user returning to a working session is
    // in — the reading below is the one that user gets. It goes through `navigateBounded` like the
    // startup load: a host-level network blip (netlink / docker-veth churn, outside this repository)
    // during the reload can interrupt the document's in-flight module requests and leave the app
    // unmounted, and an unbounded wait on the pane would read that as a product failure. The guard
    // replays the reload — a fresh document is what recovers from an interrupted load — or ends the
    // run naming the page text and the requests that failed.
    //
    // The landing is the pane, never the mark: the pane's mount is the document's own, so a replay
    // that lands here says the client came up. A product that drew the wrong *state* must still fail
    // the mark assertion below, which is what the mutation reading this criterion carries depends on.
    const paneLanding: StartupLanding = {
      label: () => `the chat pane after reconnecting to ${armB}`,
      present: (budgetMs) => appears(page.locator(PANE), budgetMs),
    };
    await navigateBounded(page, paneLanding, 'replay');
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect(markOf(page, armB)).toHaveAttribute('data-resident-state', 'busy', { timeout: 15_000 });

    // --- stopping the turn leaves the process running: the abort ---------------------------------
    const panelBeforeAbort = await readPanel(page);
    const snapshotBeforeAbort = await readHosts(api);
    const hostBeforeAbort = liveHost(snapshotBeforeAbort, armB);
    const stopLabel = readKey(chatLocale(LOCALE), 'resident.stopResident');
    if (typeof stopLabel !== 'string') throw new Error('en/chat.json has no resident.stopResident');
    const stop = page.getByRole('button', { name: stopLabel }).first();
    await stop.waitFor({ state: 'visible', timeout: 15_000 });
    await stop.click();

    await expect
      .poll(async () => completedAborts(await socketFrames(page), armB), { timeout: 15_000 })
      .toBeGreaterThan(0);

    const snapshotAfterAbort = await readHosts(api);
    const hostAfterAbort = liveHost(snapshotAfterAbort, armB);
    console.log(
      `run.status=aborted host.hostId.before=${hostBeforeAbort?.hostId ?? '(none)'} `
      + `host.hostId.after=${hostAfterAbort?.hostId ?? '(none)'} `
      + `same=${String(hostBeforeAbort?.hostId === hostAfterAbort?.hostId)}`,
    );
    const panelAfterAbort = await readPanel(page);
    console.log(
      `host.state.after=${hostAfterAbort?.state ?? '(none)'} pid.before=${hostBeforeAbort?.pid ?? '(none)'} `
      + `pid.after=${hostAfterAbort?.pid ?? '(none)'} same=${String(hostBeforeAbort?.pid === hostAfterAbort?.pid)} `
      // The debug fixture is a clock walk over a file, so its host carries no OS pid and the line above
      // reads `(none)` twice — true, and worth nothing on its own. The readings that make "the same
      // process is still here" falsifiable are the ones below: the host record's own identity and birth
      // stamp, and the pid the *panel* shows a reader, must all be unchanged by a stopped turn.
      + `startedAt.before=${hostBeforeAbort?.startedAt ?? '(none)'} startedAt.after=${hostAfterAbort?.startedAt ?? '(none)'} `
      + `startedAt.same=${String(hostBeforeAbort?.startedAt === hostAfterAbort?.startedAt)} `
      + `panel.pid.before=${JSON.stringify(panelBeforeAbort.pid)} panel.pid.after=${JSON.stringify(panelAfterAbort.pid)} `
      + `host.closeReason.after=${JSON.stringify(hostAfterAbort?.closeReason ?? null)}`,
    );
    expect(hostBeforeAbort, 'the turn was stopped inside a live process, so one must exist').not.toBeNull();
    expect(hostAfterAbort?.hostId, 'stopping a turn must not replace the process').toBe(hostBeforeAbort?.hostId);
    expect(hostAfterAbort?.pid, 'stopping a turn must not restart the process').toBe(hostBeforeAbort?.pid);
    expect(hostAfterAbort?.startedAt, 'the process the turn was stopped in must not be a new one').toBe(
      hostBeforeAbort?.startedAt,
    );
    expect(['idle', 'lingering'], 'a stopped turn leaves a process between turns').toContain(
      hostAfterAbort?.state ?? '',
    );
    expect(hostAfterAbort?.closeReason ?? null, 'a stopped turn must not close the host').toBeNull();

    // The barrier opened above is released only here, after the abort's own readings. Releasing it any
    // earlier would let the scenario's `turn-end` and `exit` fire before the abort is clicked, and the
    // `['idle','lingering']` line just above would then read an `exited` host. The abort does not wait
    // on the walk: stopping a turn is a host-layer action — it revokes the turn's lease — and that
    // assertion already holds in the unbarriered case where the click lands before `turn-end@13000`.
    //
    // The release is asserted rather than fired and forgotten. A release that never lands leaves the
    // walk on `DEBUG_AGENT_RELEASE_CEILING_MS` (20s) and the run ends red with
    // `DEBUG_AGENT_RELEASE_TIMEOUT` — a reading about the barrier, not about the product. Asserting
    // `ok` here names the layer the failure is on instead of letting the timeout above blame the mark.
    const releaseResponse = await api.post('/api/debug-agent/release', { data: { sessionId: armB } });
    const released = await releaseResponse.json().catch(() => null);
    console.log(`release.status=${releaseResponse.status()} body=${JSON.stringify(released)}`);
    expect(releaseResponse.ok(), `the barrier must be released: ${JSON.stringify(released)}`).toBe(true);

    // Read the walk's own verdict here, before the state it produces. The `exited` mark below is *made
    // by* the scenario's `exit` step, so a walk that never finished — the barrier above timing out,
    // which is the only way this scenario ends without reaching `exit` — has to be named before the
    // mark it would have moved, rather than surfacing as a locator timeout on a state nothing wrote.
    // `clockB` is the same promise the row checks below await; a healthy walk has already ended by the
    // time the release lands, so reading it here costs no wall clock.
    const clockBReading = await clockB;
    console.log(
      `walk.verdict ok=${String(clockBReading.ok)} status=${clockBReading.status} `
      + `body=${JSON.stringify(clockBReading.body).slice(0, 400)}`,
    );

    // --- the process exits on its own: exited(oom) -----------------------------------------------
    await expect(markOf(page, armB)).toHaveAttribute('data-resident-state', 'exited', { timeout: 15_000 });
    const exitedMark = await readMark(page, armB);
    const snapshotExited = await readHosts(api);
    const exitedHost = lastHost(snapshotExited, armB);
    console.log(
      `state=${STATE_WORD[exitedMark.state]} mark=${MARK_SHAPES[exitedMark.state]} `
      + `snapshot.state=${exitedHost?.state ?? 'absent'} closeReason=${exitedHost?.closeReason ?? '(none)'} `
      + `detail=${exitedHost?.closeDetail ?? '(none)'} via=scenario-step`,
    );
    expect(exitedMark.state, 'the mark and the listing must agree about the exited process').toBe(uiStateOf(exitedHost));
    expect(exitedHost?.closeReason, 'the walked process ended on its own').toBe('exited');
    expect(exitedHost?.closeDetail, 'the exit detail the scenario stated must survive to the listing').toBe('oom');
    expect(exitedMark.shape, 'the sidebar draws the exited shape').toBe(MARK_SHAPES.exited);
    expect(exitedMark.detail, 'the mark carries the same exit detail the listing publishes').toBe('oom');

    page.off('response', recordTraffic);
    const runSource = clockBReading.body?.data?.runSource ?? null;
    const seamRefusals = controlPlaneTraffic.filter((text) => text.includes('DEBUG_AGENT_RUN_SEAM_UNAVAILABLE')).length;
    console.log(`unattended.run.source=${String(runSource)} seam.unwired=${String(seamRefusals > 0)}`);
    console.log(`run.seamRefusals=${seamRefusals}`);
    expect(clockBReading.ok, `arm B's clock walk must complete: ${JSON.stringify(clockBReading)}`).toBe(true);
    expect(runSource, 'the unattended turn opens the run, so that run is the one the registry holds').toBe(
      'unattended',
    );
    expect(seamRefusals, 'a run that reaches this reading had its seam wired').toBe(0);

    // --- the transcript rows, read after a load that started from nothing ------------------------
    // Like the reload above: a deliberate reconnect that is part of the measurement rather than the
    // startup load, held to the same bounded replay so a host-level blip during the reload cannot turn
    // a document that never mounted into a red on the transcript rows below.
    await navigateBounded(page, paneLanding, 'replay');
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    // The pane mounts before its transcript does, so the rows below are awaited rather than read on
    // the next line: `toBeVisible` on the pane says the container is up, and a row count read against
    // a still-loading transcript is a reading of an empty pane — the same number a product that had
    // dropped every unattended row would produce.
    const userRow = page.locator(`[data-message-style="user"]`).filter({ hasText: SEED_USER_TEXT }).first();
    await expect(userRow, 'the stored transcript must be on screen before its rows are counted').toBeVisible({
      timeout: 30_000,
    });

    const dividers = await page.locator(DIVIDER).evaluateAll((nodes) =>
      nodes.map((node) => ({
        trigger: node.getAttribute('data-unattended-divider') ?? '',
        sender: node.getAttribute('data-unattended-sender') ?? '',
        text: (node.textContent ?? '').trim(),
      })),
    );
    const unattendedRows = await page.locator(UNATTENDED_ROW).evaluateAll((nodes) =>
      nodes.map((node) => ({
        style: node.getAttribute('data-message-style') ?? '',
        sender: node.getAttribute('data-unattended-sender') ?? '',
        text: (node.textContent ?? '').trim(),
      })),
    );

    for (const divider of dividers) {
      console.log(
        `divider=${JSON.stringify(divider.text)} trigger=${divider.trigger} `
        + `sender=${JSON.stringify(divider.sender)}`,
      );
    }
    for (const row of unattendedRows) {
      console.log(
        `row.text=${JSON.stringify(row.text)} row.class=${row.style} isUserStyle=${String(row.style === 'user')}`,
      );
    }

    expect(dividers.length, 'each unattended turn is introduced by its own divider').toBe(2);
    const cronDivider = dividers.find((divider) => divider.trigger === 'cron');
    const crossDivider = dividers.find((divider) => divider.trigger === 'cross-session');
    expect(cronDivider, 'a turn a scheduled task opened keeps that trigger on its divider').toBeTruthy();
    expect(crossDivider, 'a turn another conversation opened keeps that trigger on its divider').toBeTruthy();

    const cronTemplate = readKey(chatLocale(LOCALE), 'resident.divider.cron');
    const crossTemplate = readKey(chatLocale(LOCALE), 'resident.divider.crossSession');
    if (typeof cronTemplate !== 'string' || typeof crossTemplate !== 'string') {
      throw new Error('en/chat.json has no resident.divider templates');
    }
    // The time in a divider is the row's own timestamp, printed the way the app prints one — read off
    // the rendered sentence rather than recomputed, so this checks the *label* the trigger produced
    // and not this file's idea of what time it was. Taken whole, meridiem included: this locale's
    // clock is a twelve-hour one, and a pattern that stopped at the minutes would compare a template
    // rendered with `12:10` against a sentence that says `12:10 AM`.
    const clockOf = (text: string): string => (/(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)/i.exec(text) ?? ['', ''])[1];
    expect(cronDivider?.text, 'the scheduled-task divider is the shipped sentence for that trigger').toBe(
      render(cronTemplate, { time: clockOf(cronDivider?.text ?? '') }),
    );
    expect(crossDivider?.sender, 'the cross-session divider names the sender the scenario stated').toBe(PEER_NAME);
    expect(crossDivider?.text, 'the cross-session divider is the shipped sentence with that sender').toBe(
      render(crossTemplate, { sender: PEER_NAME, time: clockOf(crossDivider?.text ?? '') }),
    );

    expect(unattendedRows.length, 'both unattended turns render as rows of their own').toBe(2);
    for (const row of unattendedRows) {
      expect(row.style, 'a turn nobody typed must not wear the user\'s own bubble style').not.toBe('user');
    }
    // Each row must carry the words the scenario sent, not the transport
    // envelope the CLI wraps a peer message in. This is the DOM-level half of
    // the body-vs-envelope distinction the provider criterion reads off the
    // projection: a fixture that wrote the envelope (or a product that rendered
    // it) would put `Another Claude session sent a message:` on the page, and
    // the count and style lines above would still pass.
    expect(
      unattendedRows.map((row) => row.text).sort(),
      'each unattended row shows the turn\'s own words, not the envelope around them',
    ).toEqual([CRON_TURN_TEXT, CROSS_SESSION_TURN_TEXT].sort());
    console.log(
      `userRow.isUserStyle=${String((await userRow.getAttribute('data-message-style')) === 'user')} `
      + `userRow.text=${JSON.stringify((await userRow.innerText()).trim())}`,
    );
    expect(
      await userRow.getAttribute('data-message-style'),
      'the control for the two rows above: a turn the reader did type still renders as one',
    ).toBe('user');
  });

  /**
   * The shipped copy, in every locale the app ships.
   *
   * The sentences this criterion renders are read from the files the app loads, so a criterion that
   * hard-coded one would pass while the product showed nothing. This test is the other half: the keys
   * must exist, and be non-empty, in all of them — a locale missing a key renders the raw key string
   * to a user, which is a face of the product this feature must not add.
   */
  test('every shipped locale carries the keys the bar, the mark and the dividers read', async () => {
    const required: Array<{ file: 'chat.json' | 'sidebar.json'; path: string }> = [
      ...['unstarted', 'idle', 'busy', 'exited', 'start', 'restart', 'close', 'copyAddress', 'copied', 'address', 'activeCount']
        .map((key) => ({ file: 'chat.json' as const, path: `resident.statusBar.${key}` })),
      ...['label', 'aria']
        .map((key) => ({ file: 'chat.json' as const, path: `resident.badge.${key}` })),
      ...['running', 'stopped', 'exited', 'unknown']
        .map((key) => ({ file: 'chat.json' as const, path: `resident.badge.state.${key}` })),
      { file: 'chat.json', path: 'resident.backgroundTasks.count' },
      ...['cron', 'crossSession', 'backgroundTask', 'unknown']
        .map((key) => ({ file: 'chat.json' as const, path: `resident.divider.${key}` })),
      { file: 'chat.json', path: 'resident.stopResident' },
      ...['unstarted', 'idle', 'busy', 'exited']
        .map((key) => ({ file: 'sidebar.json' as const, path: `resident.mark.${key}` })),
    ];

    const missing: string[] = [];
    for (const locale of ALL_LOCALES) {
      for (const entry of required) {
        const value = readKey(readLocaleFile(locale, entry.file), entry.path);
        if (typeof value !== 'string' || value.trim().length === 0) {
          missing.push(`${locale}/${entry.file}:${entry.path}`);
        }
      }
    }

    console.log(`locales.checked=${ALL_LOCALES.length} keys.perLocale=${required.length} missing=${missing.length}`);
    console.log(`locales=${ALL_LOCALES.join(',')}`);
    expect(missing, `every locale must carry these keys; missing: ${missing.join(', ')}`).toEqual([]);
  });

  /**
   * The wall clock, against the ceiling the goal gate kills at.
   *
   * Read from the run's own start — published by `playwright.config.ts` because a spec can only see
   * itself, and the ceiling binds the whole `npx playwright test` invocation: config evaluation,
   * seeding, server boot and browser launch all happen inside it. A spec that timed its own body
   * would report a number whose shortfall against the ceiling is exactly the part it could not see.
   */
  test('the run ends inside the ceiling the goal gate kills at', async () => {
    const runStartedAt = Number(process.env.QUAY_E2E_RUN_STARTED_AT);
    const elapsed = Date.now() - runStartedAt;
    console.log(`elapsed=${elapsed}ms`);
    expect(elapsed, `the whole invocation, measured from the config's own start`).toBeLessThan(55_000);
  });
});

// ---------------------------------------------------------------------------------------------
// Small readings shared by the tests above.
// ---------------------------------------------------------------------------------------------

/** `GET /api/session-hosts`, as this file reads it. */
async function readHosts(api: APIRequestContext): Promise<HostsSnapshot> {
  const response = await api.get('/api/session-hosts');
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`GET /api/session-hosts answered ${response.status()}: ${JSON.stringify(body)}`);
  }
  return { hosts: body?.data?.hosts ?? [], sessions: body?.data?.sessions ?? [] };
}

/**
 * How many terminal `complete` frames carrying `aborted` this document has received for a session.
 *
 * The frame is the run's own report of how it ended, which is the only place "aborted" exists at all:
 * the REST listing describes the process, and a process a user stopped is still running.
 */
function completedAborts(frames: Array<Record<string, unknown>>, sessionId: string): number {
  return frames.filter(
    (frame) => frame.kind === 'complete' && frame.aborted === true && frame.sessionId === sessionId,
  ).length;
}
