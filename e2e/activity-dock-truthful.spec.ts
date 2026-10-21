/**
 * The activity dock when the server stops answering.
 *
 * What this file is *for*. The dock used to be a local table plus a local clock:
 * it kept showing one of six rotating words and counting up for as long as the
 * client believed a turn was running — which, with a dead server, was forever.
 * The criterion here is that a real browser, on a real server and a real app,
 * stops saying that: after the app's own socket is partitioned the dock reads
 * `unreachable`, the six action words are gone, the elapsed time is frozen at
 * the server's last `asOf`, and the composer's one stop entry is disabled with a
 * reason —
 * and that a released partition returns it to a *continued*, not restarted,
 * reading of the turn.
 *
 * Why a partition and not a killed server. Killing this run's server would trip
 * the 40s boot guard (a closed port reads as a stuck start, exit code 1) and
 * would poison every other case in the same invocation. What "no server" looks
 * like to a page is exactly "no frames and a closed socket", and `page.routeWebSocket`
 * can produce both on the app's own `/ws` — dropping server-to-page frames,
 * closing the page's socket, refusing reconnects and then releasing — without
 * touching the process. The proposal's §10.2 measured each of those four actions
 * in this repository's real e2e environment.
 *
 * Why the debug agent. There is no way to make a session read "processing" from
 * outside: `/api/providers/sessions/running` reads an in-memory registry that
 * seeding cannot reach. The debug agent's `unattended-turn` opens a real run for
 * a session with no client behind it, and its `POST /clock` walks the scenario by
 * absolute offsets while the response is still pending — so every reading below
 * is taken *while* the turn is open, which is the only moment a busy dock exists.
 * That gate is opened by `playwright.config.ts` for exactly this file's selection.
 *
 * The threshold is the server's, not this file's. `playwright.config.ts` injects
 * a shortened beat and silence budget into the *server* for this selection only,
 * and the readings below use what the server announced in its hello — the file
 * contains no `staleAfter` / `unreachableAfterMs` literal of its own.
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
  type BrowserContext,
  type Page,
} from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const LOCALES_ROOT = path.join(REPO_ROOT, 'src/modules/i18n/locales');
const HEARTBEAT_SERVICE = path.join(
  REPO_ROOT,
  'server/modules/websocket/services/activity-heartbeat.service.ts',
);

/** The locale the page is seeded with. */
const LOCALE = 'en';
/** Every locale the shipped keys live in — the six action words are read from all of them. */
const ALL_LOCALES = fs.readdirSync(LOCALES_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/**
 * The six rotating action words, in every locale. The unreachable dock must
 * carry none of them: excluding only the English set would pass a dock that
 * still said a translated "Thinking".
 */
const ACTION_WORDS = [...new Set(
  ALL_LOCALES.flatMap((locale) => {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(LOCALES_ROOT, locale, 'chat.json'), 'utf8'),
    ) as { claudeStatus?: { actions?: Record<string, string> } };
    return Object.values(parsed.claudeStatus?.actions ?? {});
  }).filter((word): word is string => typeof word === 'string' && word.length > 0),
)];

/** The shipped heartbeat timings, read from their one source of truth for the AC9 print. */
const SHIPPED = (() => {
  const source = fs.readFileSync(HEARTBEAT_SERVICE, 'utf8');
  const read = (name: string): number => {
    const match = source.match(new RegExp(`export const ${name} = ([\\d_]+);`));
    if (!match) throw new Error(`${HEARTBEAT_SERVICE} has no ${name}`);
    return Number(match[1].replace(/_/g, ''));
  };
  return {
    intervalMs: read('ACTIVITY_HEARTBEAT_INTERVAL_MS'),
    unreachableAfterMs: read('ACTIVITY_UNREACHABLE_AFTER_MS'),
  };
})();

/** The chat pane, the same anchor the other resident specs wait on. */
const PANE = '.chat-messages-pane';
const DOCK = '[data-activity-dock]';
const FORM = 'form[data-slot="prompt-input"]';

/** The partition's own selector: the app's chat socket, wherever it is proxied to. */
const WS_PATTERN = /\/ws(\?.*)?$/;

/**
 * The one fixture account every describe in this file signs in with.
 *
 * The server is single-user (`server/modules/auth/auth.service.ts`: the first
 * `register` owns the only slot and every later one answers 403
 * `AUTH_USER_ALREADY_CONFIGURED`). Three describes each registering a name of
 * their own therefore only ever worked under `-g`, which selects one describe and
 * leaves the slot empty for it; run the file whole and the second describe could
 * never sign in, because its register was refused and its own name did not exist
 * to log in to. So the file has exactly one name, the first describe to run
 * registers it, and `createAccount` below signs every later caller in to that
 * same account. What tells the describes apart is their fixture workspace and
 * session, never their account.
 */
const USERNAME = 'activity-dock-truthful-e2e';
const PASSWORD = 'activity-dock-truthful-e2e-pass';
const TITLE = 'Activity dock truthfulness — a turn held open';
const SEED_USER_TEXT = 'seeded user turn for the activity-dock criterion';
const WALK_TURN_TEXT = 'the turn the process is still writing';

const PHASE_TITLE = 'Activity dock phase truthfulness — a turn with phases';
const PHASE_SEED_TEXT = 'seeded user turn for the phase criterion';
const PHASE_WALK_TEXT = 'the phased turn the walk writes';

/** The composer's box, the same anchor the resident specs type into. */
const TEXTAREA = '[data-slot="prompt-input-textarea"]';
/** The message this criterion types, fails to send, then retries. */
const DRAFT = 'the draft a send to an unreachable server must not eat';

/**
 * Every state that means "a turn is running". The failed-send reading must be
 * none of them — and, because the list names states this build does not draw
 * yet, it is a statement about the shape of the answer rather than about one
 * literal string: a dock that later grows a `thinking` state cannot quietly
 * start reporting failures as thinking.
 */
const IN_TURN_STATES = new Set([
  'sending',
  'thinking',
  'writing',
  'tool',
  'awaitingPermission',
  'compacting',
  'in-turn',
]);

/**
 * One resident process, walked into a running turn and held there.
 *
 * The turn is opened at offset 0 and only ends at 14s, so every reading below
 * lands while the run registry still reports the session as processing. `wait`
 * at the end gives the walk a clean settling step after `turn-end`.
 */
const SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: TITLE, userText: SEED_USER_TEXT, lifecycleMode: 'resident' },
  steps: [
    { at: 0, op: 'unattended-turn', text: WALK_TURN_TEXT, trigger: 'cron' },
    { at: 14_000, op: 'turn-end' },
    { at: 14_500, op: 'wait' },
  ],
  expect: { rows: { delta: 1 }, content: { mustContain: [SEED_USER_TEXT, WALK_TURN_TEXT] } },
};

/** Reads one shipped locale key out of one namespace file, or undefined. */
function localeKeyIn(locale: string, file: string, keyPath: string): unknown {
  const parsed = JSON.parse(
    fs.readFileSync(path.join(LOCALES_ROOT, locale, file), 'utf8'),
  ) as Record<string, unknown>;
  return keyPath.split('.').reduce<unknown>(
    (node, segment) => (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[segment] : undefined),
    parsed,
  );
}

/** Reads one shipped `chat` key, or undefined. */
function localeKey(locale: string, keyPath: string): unknown {
  return localeKeyIn(locale, 'chat.json', keyPath);
}

const projectRow = (page: Page, workspaceName: string): Locator =>
  page.getByRole('button', { name: new RegExp(`^${workspaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first();

const sessionRow = (page: Page, sessionId: string): Locator =>
  page.locator(`a[href="/session/${sessionId}"]`).first();

async function revealSession(page: Page, workspaceName: string, sessionId: string): Promise<void> {
  const row = sessionRow(page, sessionId);
  await projectRow(page, workspaceName).waitFor({ state: 'visible', timeout: 30_000 });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await row.isVisible().catch(() => false)) return;
    await projectRow(page, workspaceName).click().catch(() => undefined);
    if (await row.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false)) return;
  }
  const body = await page.locator('body').innerText().catch(() => '<unreadable>');
  throw new Error(`the sidebar never showed a row for session ${sessionId}; page held:\n${body.slice(0, 2_000)}`);
}

/** The dock's own reading: which state it publishes, and the text and elapsed it draws. */
type DockReading = {
  state: string;
  text: string;
  elapsedMs: string | null;
  elapsedText: string | null;
  /**
   * How many interrupt controls the dock subtree offers. It must be zero at every
   * viewport: the dock reports, and the composer's submit button is the one stop
   * entry, so a count here is the duplicate this surface no longer draws.
   */
  stopCount: number;
};

async function readDock(page: Page): Promise<DockReading> {
  const dock = page.locator(DOCK).first();
  const text = (await dock.innerText()).trim().replace(/\s+/g, ' ');
  return {
    state: (await dock.getAttribute('data-activity-state')) ?? '',
    text,
    elapsedMs: await dock.getAttribute('data-activity-elapsed-ms'),
    elapsedText: text.match(/\d+m \d+s|\d+s/)?.[0] ?? null,
    stopCount: await dock.locator('button').count(),
  };
}

const wordsHit = (text: string): string[] => ACTION_WORDS.filter((word) => text.includes(word));

/**
 * How a bounded setup retry is spent.
 *
 * `SETUP_RETRY_LIMIT` counts *attempts*, not retries, and the backoff doubles from
 * `SETUP_RETRY_BASE_DELAY_MS` up to `SETUP_RETRY_MAX_DELAY_MS`. The whole loop therefore spends
 * at most 250+500+1000+1600 ≈ 3.35s asleep, which is small beside the ceilings above this file
 * (the 55s single-spec watchdog, then the gate's 60s kill) and is enough to clear a boot race that
 * resolves in a second or two. What it must never do is hide a real failure: a step that keeps
 * failing exhausts the five attempts and ends the run by name, with the last answer it saw.
 */
const SETUP_RETRY_LIMIT = 5;
const SETUP_RETRY_BASE_DELAY_MS = 250;
const SETUP_RETRY_MAX_DELAY_MS = 2_000;

/** The status a request carries when it never reached the server at all — `ECONNREFUSED`, a reset, a DNS failure. */
const TRANSPORT_FAILURE_STATUS = -1;

/** Whether a setup failure is the kind a retry can clear: a 5xx, or a request that never arrived. */
const isTransientSetupFailure = (status: number): boolean =>
  status >= 500 || status === TRANSPORT_FAILURE_STATUS;

/** What one setup request answered: its status, its parsed body, and whether it reached the server at all. */
type SetupResponse = { status: number; body: unknown; transportError: string | null };

/**
 * Sends one setup request, reporting a request that never arrived as a status rather than an exception.
 *
 * `api.post` throws on a connection the server never accepted (`ECONNREFUSED` while the run's own
 * backend is still booting), and that is exactly the failure the bounded retry below exists to re-ask.
 * Turning it into `TRANSPORT_FAILURE_STATUS` keeps every outcome on one shape — status plus detail —
 * so the retry classifies transport and HTTP failures by the same rule.
 */
async function setupPost(
  api: APIRequestContext,
  url: string,
  options?: Parameters<APIRequestContext['post']>[1],
): Promise<SetupResponse> {
  try {
    const response = await api.post(url, options);
    const body = await response.json().catch(() => null);
    return { status: response.status(), body, transportError: null };
  } catch (error) {
    return {
      status: TRANSPORT_FAILURE_STATUS,
      body: null,
      transportError: error instanceof Error ? error.message : String(error),
    };
  }
}

/** One attempt either produced its value, or a failure whose `status` decides whether it is re-asked. */
type SetupAttempt<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; detail: string };

/**
 * Re-asks a setup step while it fails transiently, with a bounded number of attempts and a doubling backoff.
 *
 * Why this exists. `beforeAll` runs against a client this run just booted (two `webServer` entries), and
 * a call that fires before the backend is accepting connections fails with `connect ECONNREFUSED` — the
 * shape the gate ledger holds verbatim for this file (`Error: arming failed (500): null`, beside
 * `[vite] http proxy error: … Error: connect ECONNREFUSED 127.0.0.1:10445`). That is a race with this
 * run's own boot, not a statement about the code under test, so it is re-asked rather than reported.
 *
 * A 4xx is never retried: the server answered, and its answer will not change by asking again.
 */
async function withSetupRetry<T>(
  what: string,
  attempt: (attemptNumber: number) => Promise<SetupAttempt<T>>,
): Promise<T> {
  let lastFailure = 'no attempt was made';
  for (let attemptNumber = 1; attemptNumber <= SETUP_RETRY_LIMIT; attemptNumber += 1) {
    const outcome = await attempt(attemptNumber);
    if (outcome.ok) {
      if (attemptNumber > 1) {
        console.log(
          `[e2e] setup retry: ${what} succeeded on attempt ${attemptNumber} after a transient failure (${lastFailure})`,
        );
      }
      return outcome.value;
    }
    lastFailure = `${outcome.status} ${outcome.detail}`;
    if (!isTransientSetupFailure(outcome.status) || attemptNumber === SETUP_RETRY_LIMIT) {
      throw new Error(`${what} failed (${outcome.status}): ${outcome.detail}`);
    }
    const delayMs = Math.min(SETUP_RETRY_BASE_DELAY_MS * 2 ** (attemptNumber - 1), SETUP_RETRY_MAX_DELAY_MS);
    console.log(
      `[e2e] setup retry: ${what} transient failure (${outcome.status} ${outcome.detail}); `
      + `attempt ${attemptNumber}/${SETUP_RETRY_LIMIT} failed, retrying in ${delayMs}ms`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  // Unreachable: the loop returns on success and throws on its last attempt.
  throw new Error(`${what} failed after ${SETUP_RETRY_LIMIT} attempts (${lastFailure})`);
}

/**
 * A test-only seam that produces a *real* transient failure on demand, for this task's own evidence.
 *
 * With `QUAY_E2E_SETUP_FAULT_ONCE` set to `account-bootstrap` or `arm-scenario`, the named step's first
 * attempt is spent against a port with nothing listening, so the failure the retry below swallows is a
 * genuine `connect ECONNREFUSED` produced by the socket layer — the same shape the boot race produces —
 * rather than a fabricated status. The retry then re-asks and reaches the real server, so the run proves
 * the backoff, the log line and the recovered value, instead of asserting them from reading the loop.
 * Nothing sets this in a real invocation and the criterion never sets it.
 */
const setupFaultOnce = process.env.QUAY_E2E_SETUP_FAULT_ONCE ?? '';
const setupFaultsFired = new Set<string>();

/** Whether the seam should spend this attempt against a dead port; fires the named step once per process. */
function shouldInjectSetupFault(label: string): boolean {
  if (setupFaultOnce !== label || setupFaultsFired.has(label)) return false;
  setupFaultsFired.add(label);
  return true;
}

/** The genuine transport failure the seam produces: one request to a port nothing is listening on. */
async function injectedTransientFailure(): Promise<SetupResponse> {
  const dead = await request.newContext({ baseURL: 'http://127.0.0.1:1' });
  try {
    return await setupPost(dead, '/api/debug-agent/scenarios');
  } finally {
    await dead.dispose();
  }
}

/**
 * Registers the shared fixture account once, then signs in to it — the one auth path this file has.
 *
 * The register branch runs only on the first describe of an invocation that reaches an empty
 * single-user server; every later describe (and every `-g` selection that starts mid-file) takes the
 * 403 `AUTH_USER_ALREADY_CONFIGURED` branch below and logs in to the account already there. Both
 * branches return the same token for the same user, which is what lets the three describes share one
 * account without any of them holding a name of its own.
 */
async function createAccount(
  api: APIRequestContext,
  username: string = USERNAME,
  password: string = PASSWORD,
): Promise<string> {
  return withSetupRetry(`signing in as ${username}`, async (attemptNumber) => {
    if (attemptNumber === 1 && shouldInjectSetupFault('account-bootstrap')) {
      const injected = await injectedTransientFailure();
      return { ok: false, status: injected.status, detail: injected.transportError ?? 'injected transient failure' };
    }

    const register = await setupPost(api, '/api/auth/register', { data: { username, password } });
    const registered = register.body as { token?: unknown; error?: { code?: unknown } } | null;
    if (typeof registered?.token === 'string') {
      const onboarding = await setupPost(api, '/api/user/complete-onboarding', {
        headers: { Authorization: `Bearer ${registered.token}` },
      });
      // A transient failure here is retried over the whole register→onboarding sequence: a second
      // register against this single-user server answers 403 and the login branch below takes over,
      // so re-asking the sequence never double-registers.
      if (isTransientSetupFailure(onboarding.status)) {
        return { ok: false, status: onboarding.status, detail: 'complete-onboarding did not answer' };
      }
      return { ok: true, value: registered.token };
    }

    // The server is single-user: the first account to register owns the only slot, and every later
    // register answers 403 AUTH_USER_ALREADY_CONFIGURED. That is not a failure of this call — it means
    // the shared fixture account is already in place — so sign in to *that* account rather than to the
    // name this describe happens to hold. Read by code, not by message: the message is UI copy.
    const alreadyConfigured = register.status === 403
      && registered?.error?.code === 'AUTH_USER_ALREADY_CONFIGURED';
    const login = await setupPost(api, '/api/auth/login', { data: { username, password } });
    const loggedIn = login.body as { token?: unknown } | null;
    if (typeof loggedIn?.token === 'string') return { ok: true, value: loggedIn.token };

    return {
      ok: false,
      // Whichever leg failed transiently decides whether the whole step is re-asked. A register that
      // never arrived is the boot race's shape and is preferred over a login that could only fail
      // because the register did.
      status: isTransientSetupFailure(register.status) ? register.status : login.status,
      detail: `${alreadyConfigured ? 'register 403 AUTH_USER_ALREADY_CONFIGURED; ' : ''}`
        + `register ${register.status} ${JSON.stringify(register.body)}; `
        + `login ${login.status} ${JSON.stringify(login.body)}`,
    };
  });
}

/**
 * Arms one scenario on the control plane, re-asking a transient failure with the same bounded retry.
 *
 * `arming failed (500): null` is the ledger's own wording for this call losing the boot race, so the
 * arm is retried exactly where the account bootstrap is. A 2xx that carries no `sessionId` is *not*
 * retried: the server answered and answered wrong, which is a statement about the code under test.
 */
async function armScenario(
  api: APIRequestContext,
  projectPath: string,
  scenario: unknown = SCENARIO,
): Promise<{ sessionId: string }> {
  return withSetupRetry(`arming the scenario for ${path.basename(projectPath)}`, async (attemptNumber) => {
    if (attemptNumber === 1 && shouldInjectSetupFault('arm-scenario')) {
      const injected = await injectedTransientFailure();
      return { ok: false, status: injected.status, detail: injected.transportError ?? 'injected transient failure' };
    }

    const response = await setupPost(api, '/api/debug-agent/scenarios', { data: { projectPath, scenario } });
    if (response.transportError !== null) {
      return { ok: false, status: response.status, detail: response.transportError };
    }
    if (response.status >= 400) {
      return { ok: false, status: response.status, detail: JSON.stringify(response.body) };
    }
    const sessionId = (response.body as { data?: { sessionId?: unknown } } | null)?.data?.sessionId;
    if (typeof sessionId !== 'string') {
      return { ok: false, status: response.status, detail: `arming returned no sessionId: ${JSON.stringify(response.body)}` };
    }
    return { ok: true, value: { sessionId } };
  });
}

async function startResidentProcess(api: APIRequestContext, sessionId: string): Promise<void> {
  const response = await api.post(`/api/session-hosts/${encodeURIComponent(sessionId)}/start`);
  if (!response.ok()) {
    throw new Error(`could not start the resident process: ${response.status()} ${await response.text()}`);
  }
}

function fireClock(api: APIRequestContext, sessionId: string) {
  return api
    .post('/api/debug-agent/clock', { data: { sessionId } })
    .then(async (response) => ({ ok: response.ok(), status: response.status() }))
    .catch((error: unknown) => ({ ok: false, status: -1, failed: String(error) }));
}

/** Records every frame the app's chat socket receives, so the announced threshold can be read. */
const recordSocketFrames = () => {
  const page = window as unknown as { __dockFrames: unknown[] };
  page.__dockFrames = [];
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      this.addEventListener('message', (event: MessageEvent) => {
        try {
          page.__dockFrames.push(JSON.parse(String((event as MessageEvent).data)));
        } catch {
          // A non-JSON frame is not part of this protocol.
        }
      });
    }
  } as unknown as typeof WebSocket;
};

const readFrames = (page: Page): Promise<Array<Record<string, unknown>>> =>
  page.evaluate(
    () => (window as unknown as { __dockFrames: Array<Record<string, unknown>> }).__dockFrames ?? [],
  );

/** The partition the app's own socket is put behind, toggled by the case below. */
type Partition = {
  /**
   * `pass` forwards both directions; `drop` forwards page-to-server but drops
   * server-to-page; `silence` drops both while leaving the socket open, so the
   * client cannot reach the server and hears nothing back; `reject` closes the
   * socket outright.
   */
  mode: 'pass' | 'drop' | 'silence' | 'reject';
  closeLive: () => void;
};

async function installPartition(page: Page, partition: Partition): Promise<void> {
  await page.routeWebSocket(WS_PATTERN, (ws) => {
    if (partition.mode === 'reject') {
      // Refuse the reconnect the way a dead server would: the socket opens for the
      // page and closes under it, so the client keeps cycling rather than hanging.
      void ws.close({ code: 1006 });
      return;
    }
    const server = ws.connectToServer();
    partition.closeLive = () => {
      void ws.close({ code: 1006 });
    };
    // Manual forwarding in both directions: once a handler is registered on a side,
    // nothing is forwarded automatically. `drop` keeps the client's own frames
    // flowing (it must still be able to subscribe) while silencing the server;
    // `silence` is the fully cut-off reading, where neither side hears the other
    // — for a send, "the server never got it", not "the server answered and the
    // answer was lost".
    ws.onMessage((message) => {
      if (partition.mode !== 'silence') {
        server.send(message);
      }
    });
    server.onMessage((message) => {
      if (partition.mode === 'pass') {
        ws.send(message);
      }
    });
  });
}

/* ── the bounded startup guard ──────────────────────────────────────────────── */
//
// This is the member of the activity-dock family that has no startup guard: its two `beforeAll`
// hooks open their page with a bare navigation to the app root (an unguarded `page.goto` followed by
// `waitForLoadState('domcontentloaded')`), whose only waits are the fixture's project row and the
// case's own anchors. When this run's own Vite dependency optimizer commits a re-optimization inside
// the page's window, the in-flight module graph is interrupted, the document is replaced under the
// navigation, and the case times out on a page that never mounted — reported as a bare locator timeout
// that names neither the url nor the status. That is exactly how AC-185's ledger entry failed
// (`Timed out waiting 30000ms from config.webServer`, `done-unresolved`): the implementation landed,
// the criterion could not, because the startup cost sat inside the measured window.
//
// The trigger (this run's own dependency optimization) is decided by the cache, not by this file. What
// is inside it is the *response*: a bounded client warm-up and a bounded navigation probe, the two
// levers the sibling specs already carry (`e2e/resident-shell-tab.spec.ts`,
// `e2e/resident-running-view.spec.ts`, `e2e/resident-status-bar.spec.ts`). Neither is invented here.
//
// The guard replays a navigation and fails loudly when it cannot land; it never treats "not landed" as
// "good enough". Written the other way — probe times out, carry on — the case would wait out its own
// budget on a blank document and the run would still cross the gate's 60s, which is what this task's
// bounded-failure reading measures.

/** A dependency the optimizer serves out of this run's private cache, already rewritten to its url. */
const OPTIMIZED_DEP_IN_TEXT = /["'](\/@fs\/[^"']*\/deps\/[^"']+\.js\?v=[0-9a-f]+)["']/;

/**
 * How long this run's own client is given to answer its app entry before the startup path gives up on it.
 *
 * The run already has two ceilings above it (playwright.config.ts's watchdog, then the goal gate's 60s)
 * and both are *outside* this spec — an unbounded wait here would be reported by whichever fired first,
 * naming neither the url nor the status.
 */
const CLIENT_WARM_DEADLINE_MS = 30_000;

/**
 * Takes this run's first dependency optimization out of the measurement window: the html shell, the app's
 * entry module, and then one optimized dependency — all requested against this run's own client before
 * any page of this run exists.
 *
 * The dependency request is the one that carries the proof, and it is why the step is not just "warm the
 * cache". The imports of a transformed module are already rewritten to this run's own
 * `/@fs/<cacheDir>/deps/<dep>.js?v=<hash>` urls, and that url only answers 200 once the optimizer has
 * committed the bundle: while the bundle is still being built the request is held, and a url carrying a
 * hash from a superseded run is exactly what a page receives `504 Outdated Optimize Dep` for. Vite
 * answers a re-optimization committed after it began serving by pushing `full-reload` to every connected
 * client, which replaces the document whole — the way this criterion has lost a page mid-flight. A 200
 * there means the page below will not race the optimizer.
 *
 * `beforeAll`, before `browser.newContext()`/`newPage()`, is the earliest point inside the criterion's
 * own startup path, and it is strictly before any page exists — the same requests the page would have
 * made, made first. It is here rather than in playwright.config.ts's `globalSetup` because Playwright
 * resolves every `globalSetup` entry as a *script* (a path that must default-export the function), so an
 * inline warm-up there is neither type-legal nor loadable, and this task's write surface allows no new file.
 *
 * Every step is bounded, including each request: a client that accepts the connection and then never
 * answers fails here, by name, with the url and the status, rather than waiting out a timeout further up.
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

  // The proof: a dependency url current for this run — re-read from the entry each attempt, because the
  // hash a url carries is the one its writer committed, and the entry is where the current one is written.
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

/**
 * Starts the client warm-up without awaiting it, and hands back the one way to collect its result.
 *
 * The warm-up talks to the client over plain HTTP and shares nothing with the control plane's own
 * calls (`createAccount`, `armScenario`, `startResidentProcess`), so a `beforeAll` can run the two
 * beside each other and pay `max(warm, bootstrap)` instead of their sum — the fixed cost this file
 * can actually overlap. The failure is captured here rather than left floating, so a describe that
 * throws in the bootstrap leg before `settle()` does not also raise an unhandled rejection from the
 * warm-up; `settle()` re-throws the warm-up's own error at the point the caller needs it, which is
 * still before any page exists.
 */
function beginClientWarmUp(clientUrl: string): { settle: () => Promise<number> } {
  const settled = warmClientStartup(clientUrl).then(
    (elapsedMs) => ({ ok: true as const, elapsedMs }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return {
    settle: async () => {
      const outcome = await settled;
      if (!outcome.ok) throw outcome.error;
      return outcome.elapsedMs;
    },
  };
}

/** Whether `locator` showed up within `timeoutMs`. */
const appears = async (locator: Locator, timeoutMs: number): Promise<boolean> =>
  locator.waitFor({ state: 'visible', timeout: timeoutMs }).then(
    () => true,
    () => false,
  );

/** How long the landing of the *first* navigation is given on its own, before the guard starts replaying. */
const STARTUP_PROBE_MS = 5_000;
/** How long each bounded replay's landing is given. Shorter than the first: a replay is a re-ask, not a cold boot. */
const STARTUP_RELOAD_PROBE_MS = 3_000;
/**
 * How long one navigation's single rpc to its server is given — the first hop and every replay hop alike.
 *
 * Tightened from 8s because this bound is what the deadline has to fit *around*: a first hop allowed to spend 8s
 * of a 12s deadline left 4s for its landing probe and nothing for the replay the guard exists to make. The
 * warm-up above has already committed this run's pre-bundle over plain HTTP before any page exists, so a healthy
 * first document is served from that cache in well under a second — the whole guard, hop plus landing, measured
 * ~2.3s quiet on this host. 5s is many times a healthy hop, and short enough that a document which is not coming
 * is abandoned while there is still budget to re-ask for it.
 */
const NAVIGATION_PROBE_MS = 5_000;

/**
 * How long the startup probe may spend proving a navigation landed, replays included.
 *
 * A deadline rather than a replay count, because it is the *sum* that has to stay inside the criterion's
 * own wall clock: the bounded-failure reading asks that a probe which cannot succeed ends the whole run
 * inside its budget, and that run pays the config evaluation, both servers' boot, the browser launch and
 * this spec's own `beforeAll` (the bounded warm-up plus the control plane's arm/start calls) before the
 * probe's first attempt even starts. Counting replays leaves that head-room to chance; a deadline spends it.
 *
 * The deadline is the one bound the replay budget is spent out of, so it has to clear the *worst case* — a first
 * hop that spends its entire bound and whose landing probe does too — with a full replay hop and its landing probe
 * still left over. Spelled out, because this sum is the whole of why the guard can replay at all:
 *
 *   first hop        NAVIGATION_PROBE_MS      = 5_000
 * + first landing    STARTUP_PROBE_MS         = 5_000
 * + replay hop       NAVIGATION_PROBE_MS      = 5_000
 * + replay landing   STARTUP_RELOAD_PROBE_MS  = 3_000
 *   ──────────────────────────────────────────────────
 *   worst case                                = 18_000  ≤  STARTUP_PROBE_DEADLINE_MS = 20_000
 *
 * so even the slowest first hop leaves a complete replay inside the deadline. That is the gap this task closes:
 * at the old deadline (12_000) an 8s first hop left 4s, the landing probe spent it, `Date.now() >= deadline` fired
 * at the throw below, and the replay never began — the guard died in the startup form on an otherwise-green tree
 * (the criterion: pass 05:20 / fail 05:22, same treeSha).
 *
 * The value is derived from *this* spec's overhead, not copied. Unlike the onboarding spec
 * (`e2e/resident-shell-tab.spec.ts`, whose three-screen wizard measured 10.2s quiet / 16.0s loaded and
 * whose deadline was fitted down to 12s for it), this spec creates its account over the API and pays only
 * the boot, the launch and the warm-up — the same overhead as the API-created siblings. 20s keeps a
 * bounded-failure run inside its budget (against the 55s single-spec watchdog and the config's own 60s kill)
 * and is the smallest round value above the 18s worst case.
 */
const STARTUP_PROBE_DEADLINE_MS = 20_000;

/**
 * What the startup page said, kept for one purpose: a startup red has to *explain* a document that was
 * pulled out from under the navigation instead of reporting that a wait ran out.
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
 * `present` and `label` are functions rather than values because both are read at attempt time: the label
 * carries the run's own workspace or session, and the locator has to be re-created against whatever
 * document is current *now*, after a replay has replaced the one the navigation started on.
 */
type StartupLanding = {
  /** Names this landing in the guard's own error, so a red says which document never came up. */
  readonly label: () => string;
  /** Whether the landing is on screen right now, within `budgetMs`. */
  readonly present: (budgetMs: number) => Promise<boolean>;
};

/**
 * The one place this file makes a *startup* navigation — both `beforeAll` hooks open their page with the
 * guarded call below, and every later navigation this file makes is the same guarded call. The control
 * plane's own `request.newContext` calls are not page navigations and are not this guard's business.
 *
 * One pass is: navigate, then probe the landing with a short budget. A landing that does not arrive has
 * the navigation replayed — a fresh document, which is exactly what recovers from in-flight module
 * requests that were interrupted once — and the probe repeated, until the deadline. When the deadline is
 * spent the guard throws with the page's own text and this run's failed-request list, never silently
 * continuing: a probe that cannot land must end the run here, with a cause, rather than let the case time
 * out on a document with nothing in it.
 *
 * The navigation itself is bounded too, and a navigation that times out is treated as a landing that did
 * not arrive rather than as an error of its own — a document that never finishes loading and a document
 * that loads without ever mounting are the same failure from here, and both end at the same named error.
 *
 * `url` is a parameter (not the fixed `/` the resident siblings hardcode) because this file also lands on
 * a session route after startup; the guard is the same for both, and both document-arrivals are bounded.
 */
const navigateBounded = async (
  page: Page,
  url: string,
  landing: StartupLanding,
  kind: 'first-load' | 'replay',
): Promise<void> => {
  const startedAt = Date.now();
  const deadline = startedAt + STARTUP_PROBE_DEADLINE_MS;
  const budgetMs = () => Math.max(1, deadline - Date.now());
  let navigationFailure: string | null = null;
  for (let attempt = 1; ; attempt += 1) {
    // Which hop this is, named before it is taken: the first-load `goto` or a replay `reload`. Both are logged
    // below, so a run's own output records every navigation attempt it made — hop 1, then each `page.reload` by
    // number — rather than only the attempt that happened to land. A replay claimed by reading the constants is
    // not the same as a replay observed in the log, and this is the log the criterion is read from.
    const isFirstHop = attempt === 1 && kind === 'first-load';
    const hopKind = isFirstHop ? 'page.goto' : 'page.reload';
    const hopTimeout = Math.min(NAVIGATION_PROBE_MS, budgetMs());
    const hopStartedAt = Date.now();
    console.log(`[e2e] client startup: hop ${attempt} (${hopKind} ${url}) begins with ${hopTimeout}ms of navigation budget`);
    try {
      if (isFirstHop) {
        await page.goto(url, { timeout: hopTimeout });
      } else {
        await page.reload({ timeout: hopTimeout });
      }
      navigationFailure = null;
      console.log(`[e2e] client startup: hop ${attempt} (${hopKind}) navigated in ${Date.now() - hopStartedAt}ms`);
    } catch (error) {
      navigationFailure = error instanceof Error ? error.message : String(error);
      console.log(
        `[e2e] client startup: hop ${attempt} (${hopKind}) did not finish navigating in ${hopTimeout}ms: ${navigationFailure}`,
      );
    }
    const landingBudget = Math.min(isFirstHop ? STARTUP_PROBE_MS : STARTUP_RELOAD_PROBE_MS, budgetMs());
    if (await landing.present(landingBudget)) {
      console.log(
        `[e2e] client startup: ${landing.label()} landed after ${Date.now() - startedAt}ms (attempt ${attempt}, ${hopKind})`,
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

test.describe.configure({ mode: 'serial' });

test.describe('activity dock truthfulness', () => {
  let page: Page;
  let api: APIRequestContext;
  let workspaceName = '';
  let sessionId = '';
  const partition: Partition = { mode: 'pass', closeLive: () => undefined };

  test.beforeAll(async ({ browser }) => {
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');
    const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
    if (!fixtureHome) throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME');
    if (!process.env.QUAY_E2E_RUN_STARTED_AT) throw new Error('playwright.config.ts must publish QUAY_E2E_RUN_STARTED_AT');

    const workspace = path.join(fixtureHome, 'activity-dock-workspace');
    workspaceName = path.basename(workspace);

    // The warm-up (see `warmClientStartup` for why it cannot sit inside the measured window) is
    // started here and settled after the control plane's own calls: it shares nothing with them, so
    // running it beside them makes this hook's startup `max(warm, account+arm+start)` rather than
    // their sum, while still finishing before any page of this describe exists.
    const warm = beginClientWarmUp(clientUrl);

    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();
    api = await request.newContext({ baseURL: clientUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });

    ({ sessionId } = await armScenario(api, workspace));
    await startResidentProcess(api, sessionId);

    // Before any page of this describe exists, so this run's own optimize/re-optimize is over before
    // the guarded navigation below. The warm-up makes plain HTTP requests; no page is created by it.
    await warm.settle();

    const context = await browser.newContext({ baseURL: clientUrl });
    await context.addInitScript(
      ({ key, value, language }: { key: string; value: string; language: string }) => {
        window.localStorage.setItem(key, value);
        window.localStorage.setItem('userLanguage', language);
      },
      { key: 'auth-token', value: token, language: LOCALE },
    );
    await context.addInitScript(recordSocketFrames);

    page = await context.newPage();
    // The partition is installed before the app ever opens its socket: the first
    // connection must already travel through the fixture for any of this to hold.
    await installPartition(page, partition);
    // The page's console and network evidence is registered before the guarded navigation, so the burst
    // that matters — this run's interrupted module requests — is inside the red the guard throws.
    page.on('console', (message) => {
      if (message.type() === 'error') {
        startupEvidence.consoleErrors.push(message.text());
        console.log(`[e2e] page console error: ${message.text()}`);
      }
    });
    page.on('requestfailed', (request) => {
      startupEvidence.failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? 'no error text'}`);
    });
    // The one startup navigation is the guard's — it lands on the fixture's project row or it ends the
    // run with the page's own text and this run's failed-request list. The cases below then expand the
    // row and click the session; those are interactions, not navigations.
    await navigateBounded(page, '/', {
      label: () => `the project row for ${workspaceName}`,
      present: (budgetMs) => appears(projectRow(page, workspaceName), budgetMs),
    }, 'first-load');
  });

  test.afterAll(async () => {
    await page?.close();

    await api?.dispose();
  });

  test('AC-184 the dock tells the truth when the app socket is partitioned', async () => {
    const startedAt = Date.now();
    const clock = fireClock(api, sessionId);

    // Open the session *after* the turn is already running, so the subscribe hello
    // reports `isProcessing` and the dock has a real turn to speak about.
    await revealSession(page, workspaceName, sessionId);
    await sessionRow(page, sessionId).click();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });

    // (i) Before the partition: a fresh, in-turn dock with the region's own evidence.
    await expect(page.locator(DOCK)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(DOCK)).toHaveAttribute('data-activity-state', 'in-turn', { timeout: 20_000 });
    const before = await readDock(page);
    console.log(`dock.state.before=${before.state}`);
    console.log(`dock.text.before=${JSON.stringify(before.text)}`);
    expect(before.state, 'before the partition the dock speaks for the running turn').not.toBe('unreachable');
    expect(before.text.length, 'the in-turn dock carries the turn\'s own text').toBeGreaterThan(0);

    // The control the partition must later grey out, read here while it is still live:
    // the reading below is only about the partition if this arm could have stopped the turn.
    const composerStop = page.locator(FORM).getByRole('button', { name: /stop/i });
    await expect(composerStop).toHaveCount(1);
    await expect(composerStop).toBeEnabled();
    console.log(`dock.composer.stop.enabled.before=${(await composerStop.getAttribute('disabled')) === null}`);

    // The threshold this selection's server announced, read from the hello the page saw.
    const hellos = (await readFrames(page)).filter((frame) => frame.kind === 'chat_subscribed');
    const announced = Number(hellos[hellos.length - 1]?.unreachableAfterMs ?? NaN);
    console.log(`dock.shipped.intervalMs=${SHIPPED.intervalMs}`);
    console.log(`dock.shipped.unreachableAfterMs=${SHIPPED.unreachableAfterMs}`);
    console.log(`dock.server.unreachableAfterMs=${announced}`);
    expect(Number.isFinite(announced), 'the server must announce its silence budget in the hello').toBe(true);
    expect(announced, 'this selection\'s server must be the shortened one').toBeLessThan(SHIPPED.unreachableAfterMs);
    expect(SHIPPED.unreachableAfterMs, 'the shipped default is untouched by the selection').toBe(15_000);

    // (ii) Partition: drop server->page frames. Past the announced threshold the dock degrades.
    const droppedAt = Date.now();
    partition.mode = 'drop';
    await expect(page.locator(DOCK)).toHaveAttribute('data-activity-state', 'unreachable', { timeout: 10_000 });
    const after = await readDock(page);
    const hits = wordsHit(after.text);
    console.log(`dock.state.after=${after.state}`);
    console.log(`dock.words.hit=${JSON.stringify(hits)}`);
    expect(after.state, 'silence past the server\'s own threshold reads unreachable').toBe('unreachable');
    expect(hits, 'no rotating action word survives into the unreachable dock, in any locale').toEqual([]);

    // (iii) The elapsed reading is frozen: two samples a second apart are byte-equal.
    const sampleA = await readDock(page);
    await page.waitForTimeout(1_200);
    const sampleB = await readDock(page);
    console.log(`dock.frozen.gap=${Date.now() - droppedAt}ms`);
    console.log(`dock.frozen.samples=${JSON.stringify([sampleA.elapsedText, sampleB.elapsedText])}`);
    expect(sampleA.elapsedText, 'the unreachable dock still shows the last server-derived elapsed').not.toBeNull();
    expect(sampleB.elapsedText, 'the elapsed reading must not advance while unreachable').toBe(sampleA.elapsedText);
    expect(sampleB.elapsedMs).toBe(sampleA.elapsedMs);

    // (iv) The dock draws no interrupt control of its own — the composer's submit
    //      button is the one stop entry — and that button is disabled with a reason
    //      the reader can see. The dock itself still says the connection is lost.
    const unreachableTitle = String(localeKey(LOCALE, 'claudeStatus.unreachable.title'));
    const unreachableStopReason = String(localeKey(LOCALE, 'claudeStatus.unreachable.stopReason'));
    console.log(`dock.stop.count=${after.stopCount}`);
    console.log(`dock.text.unreachable=${JSON.stringify(after.text)}`);
    expect(after.stopCount, 'the dock must carry no interrupt control — the composer submit is the one stop entry').toBe(0);
    expect(after.text).toContain(unreachableTitle);

    // The composer's own stop carries a different label for a resident session
    // (`input.stop` vs `resident.stopResident`), so this reads the control by role
    // and name inside the form — the only control offering a stop now.
    await expect(composerStop).toBeDisabled();
    const composerStopTitle = (await composerStop.getAttribute('title')) ?? '';
    console.log(`dock.composer.stop.label=${JSON.stringify(await composerStop.getAttribute('aria-label'))}`);
    console.log(`dock.composer.stop.disabled=${(await composerStop.getAttribute('disabled')) !== null}`);
    console.log(`dock.composer.stop.title=${JSON.stringify(composerStopTitle)}`);
    expect(composerStopTitle, 'the disabled stop must explain itself').toContain(unreachableStopReason);

    // (v) Close the socket and refuse reconnects, then release: the next reconnect
    //     within one cycle (~3s) restores the turn, and the clock is *continued*.
    partition.mode = 'reject';
    partition.closeLive();
    await expect(page.locator(DOCK)).toHaveAttribute('data-activity-state', 'unreachable', { timeout: 10_000 });

    partition.mode = 'pass';
    const releasedAt = Date.now();
    await expect(page.locator(DOCK)).toHaveAttribute('data-activity-state', 'in-turn', { timeout: 5_000 });
    const recovered = await readDock(page);
    const recoveredElapsed = Number(recovered.elapsedMs ?? NaN);
    const gapMs = releasedAt - droppedAt;
    console.log(`dock.recovered.elapsed=${recoveredElapsed}ms`);
    console.log(`dock.recovered.restart-would-be=0ms`);
    console.log(`dock.recovered.gap=${gapMs}ms after=${Date.now() - releasedAt}ms`);
    expect(recovered.state, 'a released partition returns the dock to the running turn').toBe('in-turn');
    expect(Number.isFinite(recoveredElapsed), 'the recovered dock reports a server-derived elapsed').toBe(true);
    expect(recoveredElapsed, 'the clock is continued from the turn\'s anchor, not restarted at recovery').toBeGreaterThanOrEqual(gapMs);
    expect(recoveredElapsed, 'a restarted clock would read ~0').toBeGreaterThan(0);

    const outcome = await clock;
    expect(outcome.ok, `the walk must complete: ${JSON.stringify(outcome)}`).toBe(true);

    const wall = Date.now() - startedAt;
    console.log(`dock.wall=${wall}ms`);
    expect(wall, 'the case body must land inside its own budget').toBeLessThanOrEqual(20_000);
  });

  test('AC-185 a send the server never takes fails, keeps the draft, and retries without duplicating the user row', async () => {
    const startedAt = Date.now();

    // Open the session. Not inherited from the case above: this one is selected
    // on its own (`-g "AC-185"`), and it must set up everything it reads.
    await revealSession(page, workspaceName, sessionId);
    await sessionRow(page, sessionId).click();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });

    // The app's socket is cut off from the server in both directions — nothing
    // this client sends reaches it, nothing it says comes back — while the
    // socket itself stays open. Kept open on purpose: the send path can tell at
    // a glance whether the socket is open, so a *closed* socket would take the
    // immediate-failure branch and this criterion's own deadline would never be
    // the thing under test. Here the deadline is what has to fire.
    partition.mode = 'silence';

    const textarea = page.locator(TEXTAREA);
    await textarea.fill(DRAFT);
    const draftBeforeSend = await textarea.inputValue();
    expect(draftBeforeSend, 'the draft is really in the box before the send').toBe(DRAFT);

    const sendLabel = String(localeKey(LOCALE, 'input.send'));
    const sendButton = page.locator(FORM).getByRole('button', { name: sendLabel });

    const sentAt = Date.now();
    await sendButton.click();

    // (i) The dock stops claiming a turn inside the send deadline and reports the
    //     failure, in the shipped wording, with the dock element itself present.
    await expect(page.locator(DOCK)).toHaveAttribute('data-activity-state', 'send-failed', { timeout: 5_000 });
    const after = await readDock(page);
    const latencyMs = Date.now() - sentAt;
    console.log(`send.state.afterSend=${after.state}`);
    console.log(`send.text.afterSend=${JSON.stringify(after.text)}`);
    console.log(`send.latency=${latencyMs}ms`);
    expect(after.state, 'a send the server never took is not a turn').toBe('send-failed');
    expect(
      IN_TURN_STATES.has(after.state),
      `the failed-send reading is not one of the in-turn states (got ${after.state})`,
    ).toBe(false);
    expect(after.text.length, 'the dock is present and says something — not an absent dock').toBeGreaterThan(0);
    const failureTitle = String(localeKey(LOCALE, 'claudeStatus.sendFailed.title'));
    const failureReason = String(localeKey(LOCALE, 'claudeStatus.sendFailed.reason'));
    console.log(`send.failureText=${JSON.stringify(failureTitle)}`);
    expect(
      after.text.includes(failureTitle) || after.text.includes(failureReason),
      `the dock must carry the shipped failure wording; text was ${JSON.stringify(after.text)}`,
    ).toBe(true);

    // (ii) The draft is byte-for-byte what the user typed, read off the input.
    const draftAfterSend = await textarea.inputValue();
    console.log(`draft.beforeSend=${JSON.stringify(draftBeforeSend)}`);
    console.log(`draft.afterSend=${JSON.stringify(draftAfterSend)}`);
    expect(draftAfterSend, 'a failed send leaves the draft in the box, not in a store behind an empty box').toBe(DRAFT);

    // (iii) Restore the channel; the retry must reach the server, and its user
    //       row must be the same one — the failed attempt's, not a second copy.
    const framesBeforeRelease = (await readFrames(page)).length;
    partition.mode = 'pass';
    const releasedAt = Date.now();
    await expect.poll(
      async () => (await readFrames(page)).length,
      { timeout: 5_000, message: 'server frames must reach the page again after the partition is released' },
    ).toBeGreaterThan(framesBeforeRelease);

    await sendButton.click();

    // The server took it: the running-sessions registry — the same in-memory
    // registry the app polls to derive "processing" — lists the session again.
    await expect.poll(async () => {
      const response = await api.get('/api/providers/sessions/running');
      const body = await response.json().catch(() => null);
      const sessions = (body?.data?.sessions ?? []) as Array<{ sessionId?: string }>;
      return sessions.some((session) => session.sessionId === sessionId);
    }, { timeout: 5_000, message: 'the retried chat.send must be accepted by the server' }).toBe(true);
    console.log(`send.retry.acceptedAfterMs=${Date.now() - releasedAt}ms`);

    const userRows = await page.locator(`${PANE} .chat-message[data-message-style="user"]`).evaluateAll(
      (rows, text) => rows.filter((row) => (row.textContent ?? '').includes(text)).length,
      DRAFT,
    );
    console.log(`transcript.userRows=${JSON.stringify([userRows])}`);
    expect(userRows, 'the retried text is exactly one user row, never two').toBe(1);

    const wall = Date.now() - startedAt;
    console.log(`send.wall=${wall}ms`);
    expect(wall, 'the case body must land inside its own budget').toBeLessThanOrEqual(20_000);
  });

  test('the run ends inside the ceiling the goal gate kills at', async () => {
    const runStartedAt = Number(process.env.QUAY_E2E_RUN_STARTED_AT);
    const elapsed = Date.now() - runStartedAt;
    console.log(`elapsed=${elapsed}ms`);
    expect(elapsed, 'the whole invocation, measured from the config\'s own start').toBeLessThan(55_000);
  });
});

/* =============================================================================================
 * AC-188 — the page's *one* activity dock, and the one answer about a session
 * =============================================================================================
 *
 * The family's other cases (AC-184, AC-185) are about what one dock says when the
 * server stops answering. This one is about there being one dock at all, and about
 * the three surfaces that used to answer "is this session working" separately —
 * the dock, the sidebar's running view (and the badge above it) and the composer's
 * send/stop button — answering it the same way, from the same source, at the same
 * instant.
 *
 * What the page looked like before. Activity was drawn on **four** unrelated
 * sources: a tab-shaped strip hanging off the composer (only from `md` up), a
 * compact line at the end of the transcript (only below `md`), the resident status
 * bar's own busy/idle word and lease counts, and the sidebar's running count —
 * the last two read from a one-second `/api/session-hosts` poll. Each pair could
 * disagree, and one pair reliably did: a turn that ends is announced to the page
 * at once and observed by the listing up to a beat later, so for that beat the
 * dock said idle while the sidebar still counted the session as running.
 *
 * What is read here, and why each reading can fail:
 *
 *   - **counts.** One `[data-activity-dock]` per viewport, and zero matches for the
 *     two markers the old surfaces published (`.chat-activity-tab`, the
 *     `chat-activity-inline` slot). A build that kept the old mount beside the new
 *     one reads 2, or reads a legacy marker — and neither is reachable by hiding
 *     anything with CSS, because both are counts of what exists.
 *   - **the resident surface.** On a resident session: zero matches for the
 *     busy/idle word and the lease counts, and non-zero readings for the address,
 *     the pid and the lifecycle controls inside the dock's expanded panel. The
 *     second half is what separates "merged into the dock" from "deleted".
 *   - **agreement.** While the turn is open, and then repeatedly across the window
 *     *after* `turn-end` — the window in which the old poll-driven sidebar lagged —
 *     the dock's state, the sidebar's running group membership and the composer's
 *     stop state are read in one sample each. No sample may show the dock idle
 *     while either of the other two says busy.
 *
 * Both viewports, each read once. The window is switched with `setViewportSize`,
 * which is the signal the app itself reads (`useDeviceSettings` watches `resize`),
 * so the same page really does re-render its narrow tier rather than a second
 * context standing in for it.
 *
 * The turn is the debug agent's, for the same reason the rest of this file uses
 * it: there is no way to make a session read "processing" from outside without a
 * real run. `unattended-turn` opens one with no client behind it and `turn-end`
 * closes it, so the moment the turn stops being real is a moment this file places
 * on the clock rather than waits for.
 */

/** The two markers the pre-consolidation surfaces published. Neither may match anything. */
const LEGACY_MARKERS = ['.chat-activity-tab', '[data-slot="chat-activity-inline"]'] as const;

/**
 * Every marker the resident status bar published about *activity*.
 *
 * A second busy/idle word and a count of the leases a host was holding are both a
 * second answer to the dock's question, and the page must carry neither. The
 * address/pid/close markers are deliberately **not** in this list: they survive,
 * in the dock's panel, and the criterion reads them there.
 */
const RESIDENT_ACTIVITY_MARKERS = [
  '[data-resident-status-bar]',
  '[data-resident-ui-state]',
  '[data-resident-state-text]',
  '[data-resident-lease-summary]',
  '[data-resident-lease-total]',
  '[data-lease-kind]',
  '[data-lease-count]',
] as const;

/**
 * The resident pill in the workspace header, and the panel it opens.
 *
 * These replace the dock's arrow and the panel it expanded in the message flow. The dock no longer
 * carries any resident fact: between turns it is not drawn at all, resident or not, and the process's
 * address, pid and controls are one press away on the pill, in a portal that overlays the page instead
 * of growing the transcript.
 */
const BADGE = '[data-resident-badge]';
const BADGE_PANEL = '[data-resident-badge-panel]';
const RUNNING_GROUP = '[data-running-group="running"]';

/**
 * One sample of the three surfaces, taken as close to simultaneously as a page allows.
 *
 * `composer` is not a fourth surface — it is the ground `send` was read *on*. A sample whose
 * `composer` is `absent` is one taken when the composer was not drawn at all, and its `send`
 * reading carries no information about busy or idle; see `sample()` for why that distinction is
 * the whole reason this field exists.
 */
type ConsistencySample = {
  dock: string;
  sidebar: boolean;
  send: string;
  /** Whether the composer's prompt form was drawn when `send` was read. */
  composer: 'drawn' | 'absent';
};

/**
 * The accessible names the composer's one submit control can carry, split by what each one says.
 *
 * The submit button is not a send/stop toggle any more: `6ddb14b9d` merged the Live Voice entry
 * into it, so an empty draft on an idle session shows `voice.realtime.enter` ("Start Live Voice")
 * instead of `input.send`. A reading that equated "the Send entry is not there" with "the submit
 * says stop" therefore read every idle-after-turn page as busy (filed red of 2026-10-21: the dock
 * read `absent`, the sidebar `false`, and the submit still came back `stop`, because the only
 * thing on the page was the voice entry).
 *
 * So the reading names the two states by the words the control itself publishes, and nothing else:
 *
 *   - `stop` — the turn is running (`input.stop`, or `resident.stopResident` for a resident
 *     session, which is the label this scenario's turn actually shows);
 *   - `send` — the composer is idle (`input.send`, or `voice.realtime.enter` while the draft is
 *     empty and the submit doubles as the voice entry);
 *   - `other` — anything else. A label nobody here knows is *not* folded into idle: the turn
 *     reading (which must be `stop`) and the settled reading (which must be `send`) both fail on
 *     it, so a new submit wording cannot pass silently as "not busy".
 */
type SubmitLabels = { stop: string[]; idle: string[] };

/** Classifies the submit control's accessible name into the sample's `send` field. */
const classifySubmitLabel = (label: string | null, labels: SubmitLabels): string => {
  if (label === null) return 'other';
  if (labels.stop.includes(label)) return 'stop';
  if (labels.idle.includes(label)) return 'send';
  return 'other';
};

/**
 * The accessible name on the composer's submit control, or `null` when the form draws no button.
 *
 * The control is the form's *last* button, not `button[type="submit"]`: `PromptInputSubmit`
 * renders `type={isActive ? 'button' : 'submit'}` (`src/modules/chat/composer/PromptInput.tsx`),
 * so while a turn is running — exactly the state whose name this reading is about — the stop
 * control is a plain `button`, and a `[type="submit"]` selector would find nothing there. The
 * submit is the footer's final control in both states; the form draws nothing after it.
 */
const submitAriaLabel = async (page: Page): Promise<string | null> => {
  const buttons = page.locator(`${FORM} button`);
  const count = await buttons.count();
  return count === 0 ? null : buttons.nth(count - 1).getAttribute('aria-label');
};

/**
 * How many samples a window took with no composer drawn.
 *
 * A window read off a page that had lost its composer is not evidence about two surfaces
 * disagreeing — it is evidence the page was torn down — so the readings deliberately do not turn
 * it into a disagreement (see `sample`). It is still logged, so such a run is *visible* rather
 * than silently indistinguishable from a healthy agreement.
 */
const composerAbsent = (samples: ConsistencySample[]): number =>
  samples.filter((s) => s.composer === 'absent').length;

const inTurn = (state: string): boolean => IN_TURN_STATES.has(state);

/** Everything one viewport's reading is made of. */
type ViewportReading = {
  name: string;
  docks: number;
  legacy: string[];
  residentActivityMarkers: string[];
  panel: { start: number; close: number; address: number; pid: number; copy: number };
  turn: ConsistencySample;
  afterTurn: ConsistencySample[];
  /**
   * The same three surfaces, read on this page while it was still live — from the moment the
   * walk returned until ~1.3s later. This is the window the turn-end edge is actually read
   * from; see the note on it in the case body.
   */
  afterTurnLive: ConsistencySample[];
  afterTurnIdle: ConsistencySample;
};

/**
 * Opens the Running view on one page, whichever layout that page is.
 *
 * From `md` up the sidebar is on screen and its running toggle is one press away; below it
 * the sidebar lives in a drawer the header's menu button opens. Both are the app's own
 * controls, pressed the way a user would press them — nothing here reaches into state.
 */
async function ensureRunningView(page: Page, tooltip: string): Promise<void> {
  if ((await page.locator(RUNNING_GROUP).count()) > 0) return;

  const escapedTooltip = tooltip.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const toggle = page.locator(`button[aria-label="${escapedTooltip}"]:visible`);
  const menu = page.locator('.pwa-menu-button');
  console.log(
    `cb.runningView toggle=${await toggle.count()} anyToggle=${await page.locator(`button[aria-label="${escapedTooltip}"]`).count()} `
    + `menu=${await menu.count()} menuVisible=${await page.locator('.pwa-menu-button:visible').count()}`,
  );

  // Below `md` the sidebar is a closed drawer: its contents are in the DOM but `invisible`,
  // so the header's menu button is the way in. The button is the app's own control, pressed
  // the way a user presses it.
  if ((await page.locator('.pwa-menu-button:visible').count()) > 0) {
    await page.locator('.pwa-menu-button:visible').first().click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(400);
  }

  console.log(`cb.runningView afterDrawer toggle=${await toggle.count()}`);
  if ((await toggle.count()) > 0) {
    await toggle.first().click({ timeout: 5_000 }).catch(() => undefined);
  }
  await page.waitForTimeout(250);
  console.log(`cb.runningView afterClick groups=${await page.locator(RUNNING_GROUP).count()}`);

  await expect.poll(
    async () => page.locator(RUNNING_GROUP).count(),
    { timeout: 10_000, message: `the Running view must open on this page (${tooltip})` },
  ).toBeGreaterThan(0);
}

/**
 * One sample: the dock's state, whether the sidebar counts this session as running, and the
 * submit control's state — read off the control's own accessible name, only on a composer that
 * is actually drawn (see `ConsistencySample.composer` and `SubmitLabels`).
 */
async function sample(page: Page, sessionId: string, submitLabels: SubmitLabels): Promise<ConsistencySample> {
  const group = page.locator(RUNNING_GROUP);
  const groups = await group.count();
  const sidebar = groups > 0
    ? (await group.locator(`[data-running-session="${sessionId}"]`).count()) > 0
    : false;
  if (process.env.AC188_DEBUG) {
    console.log(
      `cb.sample groups=${groups} views=${await page.locator('[data-running-view]').count()} `
      + `rows=${await page.locator('[data-running-session]').count()} `
      + `badges=${await page.locator('[data-running-badge]').count()} sidebar=${sidebar}`,
    );
  }
  // The submit's state is read off the control's own accessible name and classified by
  // `SubmitLabels`: `stop` only for the stop words, `send` only for the idle words, `other` for
  // everything else. The control keeps its identity across all three, which is the property the
  // previous reading lacked — it looked for the *Send* label and read its absence as stop, so the
  // Live Voice entry (`voice.realtime.enter`) that now replaces Send on an idle empty draft read
  // as a busy button. See `6ddb14b9d`.
  //
  // `send` is still only a reading *of a composer that is drawn*. A workspace that has unmounted
  // has no form and no submit at all, and a missing control there is not the composer saying
  // "stop" nor "send" — it is the whole surface being gone. Reading that absence as busy is what
  // the filed red of 2026-10-09 was: `{dock:'absent', sidebar:false, send:'stop'}` in *every*
  // sample of both after-turn windows, with a React error in the page console unmounting
  // `ProjectWorkspaceRouteContent` mid-window. Both surfaces vanished together; the send reading
  // then reported an absent button as a busy one. That is why `stop`/`send` are only classified
  // off a drawn composer, and the composer's presence rides on the sample (`composer`) so a
  // window taken on a torn-down page is visible as such. Off a torn-down page `send` keeps the
  // placeholder `'send'` that carries no information — the same value it had before this change.
  const composerDrawn = (await page.locator(FORM).count()) > 0;
  const submitLabel = composerDrawn ? await submitAriaLabel(page) : null;
  const send = composerDrawn ? classifySubmitLabel(submitLabel, submitLabels) : 'send';
  if (process.env.AC188_DEBUG) {
    // The raw word and the class it produced, so a green run can show *which* idle/stop wording
    // the sample was classified from rather than only the class (`AC188_DEBUG`).
    console.log(`cb.sample.submit=${JSON.stringify(submitLabel)} send=${send}`);
  }
  return {
    // `absent`, not an empty string and not a wait: a dock that is not drawn is an *answer* (there is no
    // turn to report), and `getAttribute` on a locator with no match would sit out the whole action
    // timeout before throwing — which is how an honest "nothing to say" would read as a hang.
    dock: (await page.locator(DOCK).count()) > 0
      ? ((await page.locator(DOCK).first().getAttribute('data-activity-state')) ?? '')
      : 'absent',
    sidebar,
    send,
    composer: composerDrawn ? 'drawn' : 'absent',
  };
}

/**
 * The live after-turn window's shape: how many readings it takes, and how far apart.
 *
 * 24 × 55ms ≈ 1.3s — past the one-second poll's own beat, which is the interval a source on that
 * poll lags the truth by, and short enough that the case stays inside its own budget.
 */
const LIVE_WINDOW_SAMPLES = 24;
const LIVE_WINDOW_PERIOD_MS = 55;

/**
 * The same readings as {@link sample} — the dock's state, the sidebar's membership, the submit
 * control's state classified off its accessible name on a drawn composer, and whether that
 * composer was drawn — taken `count` times *inside* the page.
 *
 * A window that samples through {@link sample} is paced by the harness, and that is the wrong clock
 * for it: every reading costs a `count()` round trip to the browser, so a 24-sample window across
 * two pages costs ~200 round trips, and on a loaded host those stretch the window from the ~1.3s it
 * is defined as to tens of seconds — past the run's own ceiling, where the run dies as a watchdog
 * kill that says nothing about what it was measuring. Evaluated in the page, the loop is paced by
 * the page's own timer and the whole window costs one round trip per page; the two pages' bursts run
 * concurrently, so their phase relationship is whatever it was, not a consequence of the harness.
 *
 * The selectors are the same strings {@link sample} uses, read through `querySelector` instead of a
 * locator. The one way those two can differ is shadow DOM — a Playwright locator pierces it and
 * `querySelector` does not — and the app attaches none: `data-running-group`, `data-running-session`
 * (both on plain elements in `RunningView.tsx`), the dock and the composer form all live in the
 * document tree, and nothing under `src/` calls `attachShadow`.
 */
async function sampleBurst(
  page: Page,
  sessionId: string,
  submitLabels: SubmitLabels,
  count: number,
  periodMs: number,
): Promise<ConsistencySample[]> {
  return page.evaluate(
    async ({ sessionId: id, stopLabels, idleLabels, count: samples, periodMs: period, group, dock, form }) => {
      const escape = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const sessionSelector = `${group} [data-running-session="${escape(id)}"]`;
      // The submit control is the form's last button — see `submitAriaLabel()` for why
      // `[type="submit"]` is not the address (the control is `type="button"` while a turn runs).
      const submitSelector = `${form} button`;
      // The same classification `classifySubmitLabel()` does on the harness side, over the same
      // two sets: stop words are busy, idle words are idle, and anything else is `other` — which
      // the turn and settled assertions red on rather than read as either state.
      const classify = (label: string | null): string => {
        if (label === null) return 'other';
        if (stopLabels.includes(label)) return 'stop';
        if (idleLabels.includes(label)) return 'send';
        return 'other';
      };
      const read = (): ConsistencySample => {
        const hasGroup = document.querySelector(group) !== null;
        const dockEl = document.querySelector(dock);
        const composerDrawn = document.querySelector(form) !== null;
        const submits = composerDrawn ? document.querySelectorAll(submitSelector) : [];
        const submitLabel = submits.length === 0
          ? null
          : submits[submits.length - 1].getAttribute('aria-label');
        return {
          // `absent`, not an empty string: a dock that is not drawn is the answer "there is no turn
          // to report", the same reading `sample()` takes when the locator matches nothing.
          dock: dockEl ? (dockEl.getAttribute('data-activity-state') ?? '') : 'absent',
          sidebar: hasGroup && document.querySelector(sessionSelector) !== null,
          // Classified off the submit control's own accessible name on a composer that is drawn.
          // Off a torn-down workspace the whole form is gone and there is nothing there to have
          // said "stop" or "send"; see `sample()` for why that is exactly the misreading the filed
          // 2026-10-09 red was, and why it is not folded in here.
          send: composerDrawn ? classify(submitLabel) : 'send',
          composer: composerDrawn ? 'drawn' : 'absent',
        };
      };
      const taken: ConsistencySample[] = [read()];
      for (let i = 1; i < samples; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, period));
        taken.push(read());
      }
      return taken;
    },
    {
      sessionId,
      stopLabels: submitLabels.stop,
      idleLabels: submitLabels.idle,
      count,
      periodMs,
      group: RUNNING_GROUP,
      dock: DOCK,
      form: FORM,
    },
  );
}

// The file-level `test.describe.configure({ mode: 'serial' })` above already covers this
// describe; Playwright refuses a second, nested assignment to the enclosing scope.
test.describe('activity dock consolidation', () => {
  let page: Page;
  let context: BrowserContext;
  let mobileContext: BrowserContext;
  let api: APIRequestContext;
  let workspaceName = '';
  let sessionId = '';
  let submitLabels: SubmitLabels;
  let runningTooltip = '';

  test.beforeAll(async ({ browser }) => {
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');
    const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
    if (!fixtureHome) throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME');

    const workspace = path.join(fixtureHome, 'activity-dock-consolidation-workspace');
    workspaceName = path.basename(workspace);

    // The submit control's two vocabularies, resolved from the same locale files the app renders
    // from: the words it publishes while a turn runs, and the words it publishes while idle. The
    // idle set has two entries because the Live Voice entry (`6ddb14b9d`) replaced Send on an
    // empty idle draft; see `SubmitLabels`.
    submitLabels = {
      stop: [
        String(localeKey(LOCALE, 'input.stop')),
        String(localeKey(LOCALE, 'resident.stopResident')),
      ],
      idle: [
        String(localeKey(LOCALE, 'input.send')),
        String(localeKey(LOCALE, 'voice.realtime.enter')),
      ],
    };
    runningTooltip = String(localeKeyIn(LOCALE, 'sidebar.json', 'search.runningTooltip'));

    // Started before the bootstrap and settled after it — the same overlap the describe above makes.
    // Before any page of this describe exists; the sibling describe above already warmed this client
    // in a full-file run, but `-g "AC-188"` selects this describe alone and runs no hook of that one,
    // so the warm has to live here too for this page's startup to be out of the measured window.
    const warm = beginClientWarmUp(clientUrl);

    const bootstrap = await request.newContext({ baseURL: clientUrl });
    // One shared account for the whole file: in a full-file run this login lands on the account the
    // first describe registered; under `-g "AC-188"` this describe is the one that registers it.
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();
    api = await request.newContext({ baseURL: clientUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });

    ({ sessionId } = await armScenario(api, workspace));

    await warm.settle();

    // The two form factors get their own contexts, because the *emulation* is part of the
    // form factor for this app: below `md` the sidebar is a drawer whose open control is a
    // touch target, and a page that claims to be a phone only by its width does not behave
    // like one. `isMobile`/`hasTouch` are the same pair the repository's own mobile layout
    // criterion uses.
    const seedAccount = ({ key, value, language }: { key: string; value: string; language: string }) => {
      window.localStorage.setItem(key, value);
      window.localStorage.setItem('userLanguage', language);
    };

    context = await browser.newContext({ baseURL: clientUrl, viewport: { width: 1280, height: 800 } });
    await context.addInitScript(seedAccount, { key: 'auth-token', value: token, language: LOCALE });
    page = await context.newPage();

    mobileContext = await browser.newContext({
      baseURL: clientUrl,
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    await mobileContext.addInitScript(seedAccount, { key: 'auth-token', value: token, language: LOCALE });
    // The page's console and network evidence is registered before the guarded navigation.
    page.on('console', (message) => {
      if (message.type() === 'error') {
        startupEvidence.consoleErrors.push(message.text());
        console.log(`[e2e] page console error: ${message.text()}`);
      }
    });
    page.on('requestfailed', (request) => {
      startupEvidence.failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? 'no error text'}`);
    });
    // The startup navigation is the guard's — it lands on the fixture's project row or it ends the run
    // with the page's own text and this run's failed-request list.
    await navigateBounded(page, '/', {
      label: () => `the project row for ${workspaceName}`,
      present: (budgetMs) => appears(projectRow(page, workspaceName), budgetMs),
    }, 'first-load');
  });

  test.afterAll(async () => {
    await page?.close();
    await mobileContext?.close().catch(() => undefined);
    await api?.dispose();
  });

  test('AC-188 one dock, no legacy surface, and one answer across the dock, the sidebar and the send button', async () => {
    const startedAt = Date.now();
    const mark = (what: string) => console.log(`ac188.step ${what} @${Date.now() - startedAt}ms`);

    // Phase one, before any process exists: the session is stored resident, so the header pill is
    // already on screen and its panel holds the resident facts — including the [start] control,
    // which only exists while nothing is running. The dock is *not* drawn: there is no turn, and a
    // resident session's dock no longer stays up between turns to carry an arrow.
    await revealSession(page, workspaceName, sessionId);
    await sessionRow(page, sessionId).click();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(BADGE)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(DOCK), 'with no turn there is no dock, resident or not').toHaveCount(0);
    mark('badge-idle');

    await page.locator(BADGE).click();
    await expect(page.locator(BADGE_PANEL)).toBeVisible({ timeout: 10_000 });
    const startControl = await page.locator(`${BADGE_PANEL} [data-resident-start]`).count();
    const closeControl = await page.locator(`${BADGE_PANEL} [data-resident-close]`).count();
    const copyControl = await page.locator(`${BADGE_PANEL} [data-resident-copy]`).count();
    const addressNode = await page.locator(`${BADGE_PANEL} [data-resident-address]`).count();
    const pidNode = await page.locator(`${BADGE_PANEL} [data-resident-pid-text]`).count();
    const panel = { start: startControl, close: closeControl, copy: copyControl, address: addressNode, pid: pidNode };
    console.log(`resident.panel.controls=${JSON.stringify(panel)}`);
    await page.locator(BADGE).click();
    await expect(page.locator(BADGE_PANEL)).toHaveCount(0);
    mark('panel-read');

    // The process comes up through the same verb the panel's own control calls, and the
    // turn is then opened *before* either page subscribes to the session. A page already
    // watching it would learn about the run from the client's five-second sync of the run
    // registry, leaving almost no window to read the open turn in; subscribing afterwards
    // puts the fact in the `chat_subscribed` hello, where the server states it directly.
    await startResidentProcess(api, sessionId);
    await expect.poll(
      async () => {
        const response = await api.get('/api/session-hosts');
        const body = await response.json().catch(() => null);
        const hosts = (body?.data?.hosts ?? []) as Array<{
          state?: string;
          bindings?: Array<{ appSessionId?: string }>;
        }>;
        return hosts.some(
          (host) => host.state !== 'closed'
            && (host.bindings ?? []).some((binding) => binding.appSessionId === sessionId),
        );
      },
      { timeout: 20_000, message: 'the resident process must be up before the turn is opened' },
    ).toBe(true);
    mark('host-up');

    const clock = fireClock(api, sessionId);

    /*
     * The window in which two sources can be caught disagreeing.
     *
     * The turn has just been opened on the server: the host layer reports its `turn`
     * lease immediately, and the page above has not been told yet — it subscribed before
     * the turn existed, so it learns about the run from the client's periodic sync of the
     * run registry, which is a five-second beat. So for a few seconds this page says
     * "nothing is running" while the *process* is demonstrably mid-turn.
     *
     * That is exactly the shape a second, poll-driven source produces: a sidebar reading
     * the one-second host listing lights up here, while the dock — reading the server's
     * own activity — does not. The reading below is therefore not about which side is
     * right (both are honest about different things) but about whether the page speaks
     * with one voice. One source, one answer: every sample must agree.
     */
    await ensureRunningView(page, runningTooltip);

    // The mobile page is opened *now*, alongside the sampling below rather than after it:
    // it must subscribe after the turn was opened on the server (that is what puts
    // `isProcessing` in its hello) and nothing about it depends on the samples.
    const mobileReady = (async () => {
      const target = await mobileContext.newPage();
      await navigateBounded(target, `/session/${sessionId}`, {
        label: () => `the chat pane on the mobile page for ${sessionId}`,
        present: (budgetMs) => appears(target.locator(PANE), budgetMs),
      }, 'first-load');
      await target.waitForLoadState('domcontentloaded');
      await expect(target.locator(PANE)).toBeVisible({ timeout: 30_000 });
      return target;
    })();

    const openWindow: ConsistencySample[] = [];
    for (let i = 0; i < 8; i += 1) {
      openWindow.push(await sample(page, sessionId, submitLabels));
      await page.waitForTimeout(70);
    }
    console.log(`consistency.turnOpen=${JSON.stringify(openWindow)}`);
    mark('turn-open-window');

    // Asserted here, before the long wait for the turn to end: a build with a second,
    // poll-driven busy/idle source fails on this reading, and a criterion should say so
    // where the evidence is, not after eight more seconds of unrelated waiting.
    expect(
      openWindow.filter((s) => !inTurn(s.dock) && (s.sidebar || s.send === 'stop')),
      'while the turn is opening, no sample may show the dock at rest while the sidebar or the send button says busy',
    ).toEqual([]);

    // Two pages, one per viewport, each created after the turn is open so each gets its own
    // hello. Separate pages rather than one resized twice: `setViewportSize` across the
    // breakpoint moves the app's tier, and moving it back leaves the sidebar collapsed —
    // a state the reading below would then be taken in for reasons that have nothing to do
    // with the dock. Each page keeps the form factor it was opened in.
    // Both pages address the session by its route rather than by clicking through the
    // sidebar: the row a click would reach is inside a drawer below `md`, and driving the
    // drawer would put a second interaction between this criterion and what it reads. The
    // sidebar is still read below — for the running group — through its own controls.
    // The navigation is the guard's, same as every other navigation in this file.
    await navigateBounded(page, `/session/${sessionId}`, {
      label: () => `the chat pane on the desktop page for ${sessionId}`,
      present: (budgetMs) => appears(page.locator(PANE), budgetMs),
    }, 'first-load');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });

    // Both pages address the session by its route rather than by clicking through the
    // sidebar: the row a click would reach is inside a drawer below `md`, and driving the
    // drawer would put a second interaction between this criterion and what it reads. The
    // sidebar is still read below — for the running group — through its own controls.
    const mobile = await mobileReady;
    mark('pages-open');

    const tiers = [
      { name: 'desktop', width: 1280, page },
      { name: 'mobile', width: 390, page: mobile },
    ] as const;

    for (const tier of tiers) {
      console.log(`ac188.tier ${tier.name} entering`);
      await ensureRunningView(tier.page, runningTooltip);
      console.log(`ac188.tier ${tier.name} runningViewReady groups=${await tier.page.locator(RUNNING_GROUP).count()}`);
      // The turn's own reading: the dock reports the server's `isProcessing` from the hello
      // this page subscribed with, so there is no poll to wait out.
      console.log(`ac188.tier ${tier.name} dockState=${await tier.page.locator(DOCK).first().getAttribute('data-activity-state')}`);
      await expect(tier.page.locator(DOCK)).toHaveAttribute('data-activity-state', 'in-turn', { timeout: 10_000 });
    }
    mark('turn-open');

    const readings: ViewportReading[] = [];
    for (const tier of tiers) {
      const docks = await tier.page.locator(DOCK).count();
      const legacy = (await Promise.all(
        LEGACY_MARKERS.map(async (marker) => ((await tier.page.locator(marker).count()) > 0 ? marker : '')),
      )).filter(Boolean);
      const residentActivityMarkers = (await Promise.all(
        RESIDENT_ACTIVITY_MARKERS.map(async (marker) => ((await tier.page.locator(marker).count()) > 0 ? marker : '')),
      )).filter(Boolean);

      const turn = await sample(tier.page, sessionId, submitLabels);
      console.log(
        `dock.count.${tier.name}=${docks} legacy.tab=${legacy.includes('.chat-activity-tab') ? 1 : 0} `
        + `legacy.inline=${legacy.includes('[data-slot="chat-activity-inline"]') ? 1 : 0} `
        + `resident.activityMarkers=${JSON.stringify(residentActivityMarkers)}`,
      );
      console.log(`consistency.turn.${tier.name}=${JSON.stringify(turn)}`);

      readings.push({
        name: tier.name,
        docks,
        legacy,
        residentActivityMarkers,
        panel,
        turn,
        afterTurn: [],
        afterTurnLive: [],
      });
    }
    mark('turn-read');

    // The turn is over on the server. `turn-end` released the host's lease when the walk
    // reached it, and this returns once the walk has run out.
    const outcome = await clock;
    expect(outcome.ok, `the walk must complete: ${JSON.stringify(outcome)}`).toBe(true);
    mark('walk-done');
    const walkDoneAt = Date.now();

    /*
     * The live after-turn window — the one the turn-end edge is actually read from.
     *
     * Why it has to be taken *here*, on the pages that were already watching. The turn ends on
     * the server when the walk releases the host's lease, and that instant is roughly half a
     * second before `await clock` returns (the scenario's own `wait` step after `turn-end`).
     * Every source on the page then clears at its own pace, and the window in which two of them
     * can be caught disagreeing is bounded by the *slowest* of them:
     *
     *   - the dock reads the run registry's in-flight bit off the activity heartbeat, so it
     *     leaves `in-turn` when the first beat *carrying* the cleared bit reaches it — measured
     *     751–788ms after the lease drops over four instrumented runs, of which 574–620ms is the
     *     wait for that beat and the remainder the registry propagation and one render;
     *   - a source on the one-second `/api/session-hosts` poll — the shape this criterion exists
     *     to catch, and the shape `RunningView` used to be — clears at its next tick, i.e.
     *     somewhere in (0, 1000ms] after the lease drops, uniformly.
     *
     * So the disagreement lives in the first second *after the turn ends*, and only on a page
     * that was live to see it. The window below is read from the two pages opened before the
     * turn was read (the same two the AC5 reading uses) the moment the walk returns, at 55ms,
     * 24 times: ~1.3s. It starts 475–508ms after the lease drops — before the dock's own departure
     * at 751–788ms, so the `in-turn` region is observed too — and ends ~1.8s after it, past the
     * last tick at which a one-second poll can still be holding the session. The settled reading
     * is taken *after* this, on these same live pages: by the time the window returns every
     * surface has already cleared (its last samples read `absent`/`false`/`send`), so the settle
     * is final rather than something the reading has to wait out.
     *
     * See the `## Evidence` of
     * `tasks/gap-ac188-criterion-agreement-loses-poll-source-falsifiability.md` for the
     * measured lag on both edges and the two falsifying implementations this window reds.
     */
    const liveStart = Date.now();
    // Both pages' bursts run at once, on their own timers: the two readings are independent
    // samples of the same edge, and running them in lockstep would make a page that happened to
    // be quick to clear hide a page that happened to be slow.
    const [liveDesktop, liveMobile] = await Promise.all([
      sampleBurst(page, sessionId, submitLabels, LIVE_WINDOW_SAMPLES, LIVE_WINDOW_PERIOD_MS),
      sampleBurst(mobile, sessionId, submitLabels, LIVE_WINDOW_SAMPLES, LIVE_WINDOW_PERIOD_MS),
    ]);
    const liveWindowMs = Date.now() - liveStart;
    console.log(`consistency.afterTurnLive.desktop=${JSON.stringify(liveDesktop)}`);
    console.log(`consistency.afterTurnLive.mobile=${JSON.stringify(liveMobile)}`);
    console.log(
      `consistency.afterTurnLive.window=${liveWindowMs}ms fromWalkDone=${liveStart - walkDoneAt}ms`,
    );
    for (const reading of readings) {
      reading.afterTurnLive = reading.name === 'desktop' ? liveDesktop : liveMobile;
    }
    mark('live-window');

    // The settled reading is taken right here, on the two pages that were already live — not, as it
    // used to be, after re-navigating each viewport so the reading would come from a fresh
    // `chat_subscribed`. That re-navigation is what made this case red under load, and it bought
    // nothing the live window above does not already have:
    //
    //   - Its `page.goto` waits for `load`. On a loaded host the client's module graph pushed the
    //     `load` event past the guard's own 5s navigation probe, so the guard replayed the whole
    //     document (`page.reload`) and the `live-window`→`turn-closed` segment grew from ~2.4s quiet
    //     to ~6.7s loaded — the fixed cost that then pushed `dock.wall` over this case's budget.
    //   - The state it produced is the state that is already here. The dock's departure is observed
    //     *on these pages* by the live window (whose own `some(!inTurn)` assertion below proves it),
    //     the run registry's cleared in-flight bit is what both the dock and the sidebar read, and by
    //     the time that window returns its last samples read `absent`/`false`/`send` — exactly the
    //     settled state asserted below. A fresh subscribe can only restate what the window measured.
    //
    // Measured 2026-10-09 on the filing's tree: tail `walk-done`→`sampled` 4.8s quiet / 10.0s loaded,
    // of which this re-navigation was 2.4s / 6.7s; the walk itself stayed at 15.0–16.2s throughout.
    // The dock settles on *absent*: the turn is over, and a resident session's dock no longer lingers in an
    // idle reading. Every sample in the window below reads `absent` through `sample()`, which is not a
    // running state — so the agreement it checks (no sample may show the dock at rest while the sidebar
    // or the send button still says busy) is unchanged, and now also catches a dock that outstays its turn.
    await expect(page.locator(DOCK)).toHaveCount(0, { timeout: 20_000 });
    const endedAt = Date.now();
    mark('turn-closed');

    for (const reading of readings) {
      const target = reading.name === 'desktop' ? page : mobile;
      const samples: ConsistencySample[] = [];
      for (let i = 0; i < 8; i += 1) {
        samples.push(await sample(target, sessionId, submitLabels));
        await target.waitForTimeout(55);
      }
      reading.afterTurn = samples;
      console.log(`consistency.afterTurn.${reading.name}=${JSON.stringify(samples)}`);
      // The window the agreement is about: 8 samples at 55ms span ~0.5s, taken the moment
      // the dock reads idle — the interval in which a surface on a slower clock would still
      // be saying busy.
      console.log(`consistency.afterTurn.window.${reading.name}=${Date.now() - endedAt}ms`);
    }
    mark('sampled');

    // The live window's own shape, before the readings are judged: it has to outlast the beat a
    // poll-driven source would lag by, or a red would be about the window rather than about the
    // surfaces agreeing.
    expect(
      liveWindowMs,
      'the live after-turn window must span more than one beat of the one-second poll it is about',
    ).toBeGreaterThanOrEqual(1_000);

    // A window taken on a page whose composer had unmounted is not two surfaces disagreeing, and
    // the readings above do not turn it into one (see `sample`). It is logged here instead, so a
    // run that read a torn-down page is visible in its own output rather than looking exactly like
    // a healthy agreement. Deliberately not an assertion: the substantive readings stay exactly as
    // they were, and a page that has lost its composer is a harness/host condition, not a defect
    // of the three surfaces this case is about.
    for (const reading of readings) {
      console.log(
        `consistency.composerAbsent.${reading.name}=`
        + `live:${composerAbsent(reading.afterTurnLive)}/${reading.afterTurnLive.length} `
        + `settled:${composerAbsent(reading.afterTurn)}/${reading.afterTurn.length}`,
      );
    }

    // ---- the claims -------------------------------------------------------------------------
    for (const reading of readings) {
      const tier = reading.name;

      // AC2 — one dock, on this viewport, while the turn is open.
      expect(reading.docks, `${tier}: exactly one [data-activity-dock] must exist`).toBe(1);

      // AC3 — the two markers the old surfaces published match nothing at all. Not hidden: absent.
      expect(
        reading.legacy,
        `${tier}: the old tab class and the inline slot must not match anything`,
      ).toEqual([]);

      // AC4 — the resident surface's own activity word and lease counts are gone from the page...
      expect(
        reading.residentActivityMarkers,
        `${tier}: the resident surface must publish no busy/idle word and no lease count`,
      ).toEqual([]);
      // ...and the facts it carried are reachable in the dock's panel, which is what makes it
      // a merge rather than a deletion.
      expect(reading.panel.start, `${tier}: the panel still offers [start] while no process is up`).toBeGreaterThan(0);
      expect(reading.panel.close, `${tier}: the panel still offers [close]`).toBeGreaterThan(0);
      expect(reading.panel.copy, `${tier}: the panel still offers [copy]`).toBeGreaterThan(0);
      expect(reading.panel.address, `${tier}: the panel still shows the address`).toBeGreaterThan(0);
      expect(reading.panel.pid, `${tier}: the panel still shows the pid`).toBeGreaterThan(0);

      // AC5 — three surfaces, one sample, one answer.
      expect(inTurn(reading.turn.dock), `${tier}: the dock must read in-turn while the turn is open`).toBe(true);
      expect(reading.turn.sidebar, `${tier}: the sidebar must count the session as running`).toBe(true);
      expect(reading.turn.send, `${tier}: the submit must be the stop entry`).toBe('stop');

      // AC6 — and after the turn: no sample in the window may show the dock idle while
      // either other surface still says busy.
      const disagreements = reading.afterTurn.filter((s) => !inTurn(s.dock) && (s.sidebar || s.send === 'stop'));
      expect(
        disagreements,
        `${tier}: no reading may show the dock idle while the sidebar or the send button still says busy`,
      ).toEqual([]);

      // AC6, read where it can actually be broken. The window above is taken after both pages
      // were re-navigated, which is exactly the region in which a one-second poll has already
      // caught up — so it can only ever confirm that everything settled. The live window starts
      // while the dock is still reporting the turn and runs a full poll beat past the end of it,
      // which is the only place a second, slower source can be caught saying busy after the dock
      // has stopped. The direction is the same one, unchanged: the dock must never be the first
      // to stop.
      const liveDisagreements = reading.afterTurnLive.filter(
        (s) => !inTurn(s.dock) && (s.sidebar || s.send === 'stop'),
      );
      expect(
        liveDisagreements,
        `${tier}: no live reading may show the dock leave the turn while the sidebar or the send button still says busy`,
      ).toEqual([]);
      // ...and the window is only evidence if it watched the turn end at all: a window whose
      // every sample still read `in-turn` would satisfy the claim above while measuring nothing.
      expect(
        reading.afterTurnLive.some((s) => !inTurn(s.dock)),
        `${tier}: the live window must observe the dock leave the turn, or it is not a reading of the turn ending`,
      ).toBe(true);

      const settled = reading.afterTurn[reading.afterTurn.length - 1];
      expect(settled.dock, `${tier}: the dock settles on absent — nothing is running, so nothing is drawn`).toBe('absent');
      expect(settled.sidebar, `${tier}: and the sidebar stops counting the session`).toBe(false);
      expect(settled.send, `${tier}: and the submit is the send entry again`).toBe('send');
    }

    await mobile.close();

    const wall = Date.now() - startedAt;
    console.log(`dock.wall=${wall}ms`);
    // The measured floor, and why this guard sits where it does. The body is one debug-agent turn walk
    // (`unattended-turn@0` → `turn-end@5000` → `wait@5500`), whose `await clock` returns at ~15.0s
    // because the control plane takes several seconds to pick the request up behind this run's page
    // loads — the ordering the scenario's own note above describes, and a cost the walk cannot
    // compress. Above that floor sits exactly one mandatory cost: AC6's 8×55ms settled window per
    // viewport, read on the two pages the live window already used. The re-navigation that used to sit
    // above the floor was removed on 2026-10-09 — it was the case's one *load-sensitive* term, and the
    // `page.goto`/`page.reload` it spent is why the body crossed a guard that had already been raised
    // to 30s (filed: 30607ms at load1≈110, every substantive reading in that run correct — the budget
    // red, not the reading; the earlier task that set 30s had assumed a ~4s tail, measured when the
    // re-navigation happened not to trip its 5s probe).
    //
    // Re-measured on 2026-10-09, this tree, `-g "AC-188"`, 11 runs: `walk-done` 15.0–16.9s (stable
    // across load), the tail 2.4–3.3s, the body 17.4–20.1s — quiet (load1 21–53) 17.4–17.6s, loaded
    // (load1 160–165, runnable ≈160) 19.5–20.1s. The load-sensitive term is gone: the same loads before
    // the fix read 24.7–26.2s. 25s clears the worst measured body by ~5s and stays well inside
    // `SINGLE_SPEC_CEILING_MS`, which is unchanged.
    expect(wall, 'the case body must land inside its own budget').toBeLessThanOrEqual(25_000);
  });
});

/* =============================================================================================
 * AC-187 — the dock's words come from the real phase of a real turn
 * =============================================================================================
 *
 * The family's other cases are about what the dock says when the *transport*
 * fails. This one is about the source of the words themselves. The dock used to
 * pick one of six rotating adjectives from a local clock — `actionWords[floor(
 * elapsedSeconds / 4) % 6]` — so the same running turn said a different thing
 * every four seconds and said nothing at all about what was actually happening.
 *
 * Here a real debug-agent turn walks a real signal sequence: it thinks, it calls
 * `Bash`, the call returns, it writes, the turn ends. The server reduces those
 * raw rows to a phase (AC-186's tracker), stamps the phase onto the activity
 * frames it already beats (AC-182's heartbeat), and the dock draws the locale's
 * word for that phase — with the tool's own name, which no clock and no lookup
 * table could produce. The shape this case pins, in one run:
 *
 *   - the phases arrive in order, thinking -> tool -> writing -> idle;
 *   - the label equals the locale's value for the phase (and names `Bash`);
 *   - six seconds inside the tool phase say the SAME thing six times; and
 *   - when the turn ends, the dock stops claiming a turn.
 *
 * The criterion is the `-g "AC-187"` selection, which runs this describe's hooks
 * (and no other describe's): the page is opened here, after this selection's own
 * warm-up.
 */

/** The tool the turn calls; the dock must read this name off the server's frames. */
const PHASE_TOOL_NAME = 'Bash';
/** Six seconds of wall clock, sampled once a second — the stability window. */
const PHASE_STABLE_STEP_MS = 1_000;

/** One phase reading off the dock: its state, the phase it publishes, and its label. */
type PhaseReading = { state: string; phase: string; label: string };

/** Reads the dock's phase, state and running label (the shimmer's ellipsis stripped). */
async function readPhaseDock(page: Page): Promise<PhaseReading> {
  const dock = page.locator(DOCK).first();
  const state = (await dock.getAttribute('data-activity-state')) ?? '';
  const phase = (await dock.getAttribute('data-activity-phase')) ?? '';
  const labelEl = dock.locator('[data-activity-label]');
  const raw = (await labelEl.count()) > 0 ? await labelEl.first().innerText() : '';
  return { state, phase, label: raw.replace(/[…]+$/, '').replace(/\.+$/, '').trim() };
}

/** The shipped `chat` value for a phase, with `{{tool}}` filled in. */
function phaseLabel(locale: string, key: string, tool?: string): string {
  const value = String(localeKey(locale, `claudeStatus.phases.${key}`));
  return tool === undefined ? value : value.replace('{{tool}}', tool);
}

/**
 * The phase walk: one unattended turn whose raw rows carry each signal the dock
 * must speak for. The tool phase is held for ~9s so the six-second stability
 * window fits wholly inside it, and the thinking phase is held long enough that
 * a client subscribing a beat after the walk starts still lands inside it.
 *
 * The tool plateau is `tool-result.at − tool-call.at`, and the stability window
 * needs 6.0s of it with room for the client's own detection latency: `t0` (the
 * reading that first sees the tool phase) must satisfy `t0 + 6000 <
 * tool-result.at`. With the tail at 12_000 the plateau was 7.0s — a ~1.0s
 * margin, which under lane load the `toHaveAttribute` poll and the clock's own
 * start drift ate, pushing the window's seventh reading across the real
 * `tool`→`writing` boundary (filed: `phases were ["tool"×6,"writing"]`). The
 * tail is shifted a uniform +2_000ms so the plateau is 9.0s and the margin
 * 3.0s; `tool-call@5_000` and the `thinking→tool→writing→idle` order are
 * unchanged, and the writing window keeps its 1.4s.
 */
const PHASE_SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: PHASE_TITLE, userText: PHASE_SEED_TEXT, lifecycleMode: 'resident' },
  steps: [
    { at: 0, op: 'unattended-turn', text: PHASE_WALK_TEXT, trigger: 'cron' },
    { at: 400, op: 'thinking-tokens' },
    { at: 5_000, op: 'tool-call', name: PHASE_TOOL_NAME },
    { at: 14_000, op: 'tool-result', text: `${PHASE_TOOL_NAME} finished` },
    { at: 14_100, op: 'text-delta', text: 'now writing the answer' },
    { at: 15_500, op: 'turn-result' },
    { at: 16_000, op: 'turn-end' },
  ],
  expect: { rows: { delta: 6 }, content: { mustContain: [PHASE_WALK_TEXT, PHASE_TOOL_NAME] } },
};

test.describe('activity dock phase truthfulness', () => {
  let page: Page;
  let api: APIRequestContext;
  let workspaceName = '';
  let sessionId = '';

  test.beforeAll(async ({ browser }) => {
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');
    const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
    if (!fixtureHome) throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME');
    if (!process.env.QUAY_E2E_RUN_STARTED_AT) throw new Error('playwright.config.ts must publish QUAY_E2E_RUN_STARTED_AT');

    const workspace = path.join(fixtureHome, 'activity-dock-phase-workspace');
    workspaceName = path.basename(workspace);

    // Started before the bootstrap and settled after it — the same overlap the sibling describes make.
    const warm = beginClientWarmUp(clientUrl);

    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();
    api = await request.newContext({ baseURL: clientUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });

    ({ sessionId } = await armScenario(api, workspace, PHASE_SCENARIO));
    await startResidentProcess(api, sessionId);

    await warm.settle();

    const context = await browser.newContext({ baseURL: clientUrl });
    await context.addInitScript(
      ({ key, value, language }: { key: string; value: string; language: string }) => {
        window.localStorage.setItem(key, value);
        window.localStorage.setItem('userLanguage', language);
      },
      { key: 'auth-token', value: token, language: LOCALE },
    );

    page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') console.log(`[e2e] page console error: ${message.text()}`);
    });
    await navigateBounded(page, '/', {
      label: () => `the project row for ${workspaceName}`,
      present: (budgetMs) => appears(projectRow(page, workspaceName), budgetMs),
    }, 'first-load');
  });

  test.afterAll(async () => {
    await page?.close();
    await api?.dispose();
  });

  test('AC-187 the dock speaks the real phase: thinking, Bash, writing, idle — and holds still inside a phase', async () => {
    const startedAt = Date.now();
    // Fire the walk first, so the subscribe below lands while the turn is running
    // and the thinking phase is still on the clock (it is held until 6.5s).
    const clock = fireClock(api, sessionId);

    await revealSession(page, workspaceName, sessionId);
    await sessionRow(page, sessionId).click();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(DOCK)).toBeVisible({ timeout: 20_000 });

    // (i) thinking — the positive control that the label is the locale's word for
    //     the phase, not an empty string and not a rotated adjective.
    await expect(page.locator(DOCK)).toHaveAttribute('data-activity-phase', 'thinking', { timeout: 15_000 });
    const thinking = await readPhaseDock(page);
    const expectedThinking = phaseLabel(LOCALE, 'thinking');
    console.log(`dock.phase.thinking=${JSON.stringify({ state: thinking.state, phase: thinking.phase, label: thinking.label })}`);
    console.log(`dock.phase.thinking.expected=${JSON.stringify(expectedThinking)}`);
    expect(thinking.state, 'the thinking phase is a running turn').toBe('in-turn');
    expect(thinking.label, 'the label is the locale word for the thinking phase').toBe(expectedThinking);

    // (ii) tool — the label names the tool the turn actually called.
    await expect(page.locator(DOCK)).toHaveAttribute('data-activity-phase', 'tool', { timeout: 15_000 });
    const tool = await readPhaseDock(page);
    const expectedTool = phaseLabel(LOCALE, 'tool', PHASE_TOOL_NAME);
    console.log(`dock.phase.tool=${JSON.stringify({ state: tool.state, phase: tool.phase, label: tool.label })}`);
    console.log(`dock.phase.tool.expected=${JSON.stringify(expectedTool)}`);
    expect(tool.label, 'the tool phase label names the pending tool').toContain(PHASE_TOOL_NAME);
    expect(tool.label, 'the tool phase label is the locale value for the tool phase').toBe(expectedTool);

    // (iii) stability — six seconds inside one phase say the same thing.
    const samples: PhaseReading[] = [tool];
    for (let step = 1; step <= 6; step += 1) {
      await page.waitForTimeout(PHASE_STABLE_STEP_MS);
      samples.push(await readPhaseDock(page));
    }
    const phases = samples.map((sample) => sample.phase);
    const labels = samples.map((sample) => sample.label);
    const spanMs = PHASE_STABLE_STEP_MS * 6;
    console.log(`dock.stable.span=${spanMs}ms`);
    console.log(`dock.stable.samples=${JSON.stringify(labels)}`);
    console.log(`dock.stable.phases=${JSON.stringify(phases)}`);
    expect(spanMs, 'the stability window covers at least five seconds').toBeGreaterThanOrEqual(5_000);
    expect(samples.length, 'at least six readings').toBeGreaterThanOrEqual(6);
    expect(new Set(phases), `every reading lands in the tool phase; phases were ${JSON.stringify(phases)}`).toEqual(new Set(['tool']));
    expect(new Set(labels), `the label must not rotate while the phase holds; readings were ${JSON.stringify(labels)}`).toEqual(new Set([expectedTool]));

    // (iv) writing — the phase moves on, and the label follows it.
    await expect(page.locator(DOCK)).toHaveAttribute('data-activity-phase', 'writing', { timeout: 10_000 });
    const writing = await readPhaseDock(page);
    const expectedWriting = phaseLabel(LOCALE, 'writing');
    console.log(`dock.phase.writing=${JSON.stringify({ state: writing.state, phase: writing.phase, label: writing.label })}`);
    console.log(`dock.phase.writing.expected=${JSON.stringify(expectedWriting)}`);
    expect(writing.label, 'the label is the locale word for the writing phase').toBe(expectedWriting);

    // (v) the turn ends. The walk's own terminal record already returned the
    //     server's phase to idle; the client's *turn* reading is refreshed the
    //     same way AC-188 settles it — a fresh subscribe, whose `isProcessing` is
    //     the server's answer for the session at that instant. The ack the page
    //     then holds must not claim a running turn.
    const outcome = await clock;
    expect(outcome.ok, `the walk must complete: ${JSON.stringify(outcome)}`).toBe(true);

    await navigateBounded(page, `/session/${sessionId}`, {
      label: () => `the chat pane after the phased turn closed for ${sessionId}`,
      present: (budgetMs) => appears(page.locator(PANE), budgetMs),
    }, 'first-load');
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });

    // After the turn the dock is not drawn at all. That is a stronger statement than the old "reads idle":
    // an idle reading could be a dock stuck on its last frame, and an absent one cannot be.
    await expect(page.locator(DOCK)).toHaveCount(0, { timeout: 20_000 });
    console.log('dock.afterTurn=absent');

    const wall = Date.now() - startedAt;
    console.log(`dock.wall=${wall}ms`);
    // The measured floor, and why this guard sits where it does. The body's floor is the walk's own
    // `turn-end` (the moment `await clock` returns) plus exactly one mandatory cost: the post-turn
    // re-navigation that settles the after-turn reading. The tail shift that gave the tool phase its
    // 3.0s margin moved `turn-end` from 14_000 to 16_000, so the floor rose 2.0s with it: quiet
    // `dock.wall` went 15_491–15_730ms → 17_512–18_395ms. 25s clears the worst measured body by
    // ~6.6s and stays well inside `SINGLE_SPEC_CEILING_MS` (55s) and the gate's 60s kill; it is the
    // same value the sibling AC-188 case above reads its budget at, for the same floor.
    expect(wall, 'the case body must land inside its own budget').toBeLessThanOrEqual(25_000);
  });
});
