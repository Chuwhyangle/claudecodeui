import { expect, test } from '@playwright/test';
import type { Browser, Locator, Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

// Real Chromium against a real backend and a real Vite client, twice: once with `MCP_ENABLED` on and once with it
// off. Playwright's shared `webServer` carries one fixed environment, so this spec starts its OWN server per state,
// against a throwaway data directory — the same shape `scripts/resident-smoke.mjs` and
// `scripts/voice-capture-process-check.mjs` use. Both states bind one fixed server port in turn, and the run's
// `playwright.config.ts` leaves its own `webServer` pair unstarted for this one-file selection (see
// `mcpSettingsOnlySelection` there): a config server here would be a second, unused server holding the very port, and
// the spec serving the run's two published ports is also what keeps the watchdog, which probes those urls, honest.
// The two states differ only in the SERVER's `MCP_ENABLED`, so ONE Vite client (whose `/api` proxy points at the one
// server port both states bind in turn) is booted for the whole file and warmed once: a second Vite and its second
// cold pre-bundle bought the criterion nothing. Nothing about the backend is stubbed: the settings page asks the
// state's own server over the shared Vite `/api` proxy, and the scope reading below is a real
// `GET /api/oauth/token-info` carrying the token the form really issued.
//
// The build under test is the worktree's own source, served by Vite (not a possibly-stale `dist/`), so a change to
// `McpGatewaySection.tsx` or `AccessTokensSection.tsx` is what the browser renders.
//
// The startup path is bounded in the same two levers its sibling specs use (`e2e/access-tokens-settings.spec.ts`,
// `e2e/model-library.spec.ts`): a per-state client warm-up before any page exists, and a single bounded navigation
// guard. The lever exists because the trigger is OUTSIDE this repo: a host-level `net::ERR_NETWORK_CHANGED` (docker
// /veth churn on the runner) aborts this app's in-flight module requests as a batch, the module graph never executes,
// React never mounts, and `#username` never appears — an unbounded 30s `toBeVisible` wait turned that transient into
// a red. What this file fixes is the *response* (unbounded wait → bounded replay of a fresh document), not the
// trigger: the guard's stability rests on replay, never on the host network change going away.

const REPO_ROOT = process.cwd();
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const VITE_BIN = path.join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

/** The two gate states this criterion drives, each naming the exact `MCP_ENABLED` value its server boots with. */
type GateState = {
  label: 'enabled' | 'disabled';
  /**
   * The value exported as `MCP_ENABLED`. Always an explicit value — never absent.
   *
   * `server/load-env.ts` backfills every key the spawned child does not already carry from the deployer's
   * repo-root `.env`, writing back only while `!process.env[key]` holds. So leaving the key out is NOT a way
   * to spell the off state: in a checkout whose `.env` pins `MCP_ENABLED=true`, an absent key is silently
   * rewritten to `true` and the disabled reading flips to "enabled". The gate reads the explicit `false` as
   * closed (`readMcpGatewayGate('false')`), which is the state this criterion means.
   */
  mcpEnabled: string;
};

const ENABLED_STATE: GateState = { label: 'enabled', mcpEnabled: 'true' };
const DISABLED_STATE: GateState = { label: 'disabled', mcpEnabled: 'false' };

/** The five scope vocabulary values, in the order the create form renders them. */
const SCOPE_VOCABULARY = [
  'cloudcli:read',
  'cloudcli:session:send',
  'cloudcli:session:create',
  'cloudcli:session:control',
  'cloudcli:approve',
] as const;

/** How long a spawned child is given to answer before the criterion gives up on it, naming its own log tail. */
const CHILD_READY_TIMEOUT_MS = 30_000;
/** How long a browser landing is given before the criterion reads the page back as evidence. */
const LANDING_TIMEOUT_MS = 30_000;

/**
 * The keys each booted server's readings depend on. Every one MUST be pinned explicitly on the child's env.
 *
 * An absent key is not a state here: `server/load-env.ts` writes it back from `<repo root>/.env` whenever
 * `!process.env[key]` holds. `MCP_ENABLED` decides the (a)/(b) status reading; `PUBLIC_BASE_URL` decides the
 * (a) endpoint's base (`settings.module.ts` exposes it as `gateway.publicBaseUrl()`, and
 * `settings.service.ts` falls back to `origin` only when it is null/empty). Both are therefore named here and
 * asserted present on every state's env, so a future edit that reached for "delete the key" fails loudly
 * instead of flipping a reading on whichever machine happens to have a `.env`.
 */
const READING_KEYS = ['MCP_ENABLED', 'PUBLIC_BASE_URL'] as const;

/**
 * The key NAMES this checkout's repo-root `.env` defines, or `[]` when there is none.
 *
 * Read (never written) so a deployer's environment is visible in the run's own output instead of quietly
 * deciding a reading. The criterion does not care what the values are — it cares that no reading can be
 * flipped by them, which is what `READING_KEYS` guarantees. Logging the names is the cheap guard that makes a
 * future `.env` change show up in a red's own output rather than as a silent flip.
 */
const readDotenvKeys = (): string[] => {
  try {
    return fs
      .readFileSync(path.join(REPO_ROOT, '.env'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => (line.split('=')[0] ?? '').trim())
      .filter((key) => key.length > 0);
  } catch {
    // No `.env` is a normal checkout; the coupling this criterion guards against is simply absent.
    return [];
  }
};

// ---------------------------------------------------------------------------
// HTTP / process plumbing
// ---------------------------------------------------------------------------

/**
 * One HTTP exchange over `node:http`, deliberately not the global `fetch`.
 *
 * `listen(0)` + undici is a known bad-port lottery in this repo; every request this criterion makes goes through
 * `node:http` so the port the kernel handed back can never be rejected by an unrelated client policy.
 */
const httpRequest = (
  method: string,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
  const target = new URL(url);
  const request = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
    },
    (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    },
  );
  request.on('error', reject);
  request.setTimeout(10_000, () => request.destroy(new Error(`no answer from ${url} within 10000ms`)));
  request.end();
});

/** Asks the kernel for a free loopback port. The probe socket is closed before the value is handed back. */
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    if (address === null || typeof address === 'string') {
      probe.close(() => reject(new Error('the kernel did not hand back a numeric port')));
      return;
    }
    const { port } = address;
    probe.close(() => resolve(port));
  });
});

/**
 * The port THIS RUN published for one of its two servers, read from the environment the config hands the workers.
 *
 * The config allocates both ports and the watchdog probes exactly those two urls for a stall — and, for this
 * criterion's one-file invocation, starts no `webServer` of its own (see `mcpSettingsOnlySelection` there). So the
 * spec has to serve the ports the watchdog is watching: binding a fresh kernel-assigned pair would leave both of the
 * watchdog's urls dark and turn a merely slow run into a kill reported, wrongly, as a stalled `webServer-start`.
 * `null` — fall back to `freePort()` — is only the standalone case, where nothing published a pair and no watchdog
 * is watching one.
 */
const runPort = (name: 'QUAY_E2E_SERVER_PORT' | 'QUAY_E2E_CLIENT_PORT'): number | null => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : null;
};

/** Polls `url` until it answers a 2xx/3xx, or throws with the child's own log tail so a boot failure is legible. */
const waitForHttp = async (url: string, describeLog: () => string): Promise<void> => {
  const deadline = Date.now() + CHILD_READY_TIMEOUT_MS;
  let lastAnswer = 'no request was ever attempted';
  while (Date.now() < deadline) {
    try {
      const { status } = await httpRequest('GET', url);
      if (status >= 200 && status < 400) return;
      lastAnswer = `HTTP ${status}`;
    } catch (error) {
      lastAnswer = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `${url} never answered inside ${CHILD_READY_TIMEOUT_MS}ms (last: ${lastAnswer}); child output tail:\n`
    + describeLog().split('\n').slice(-25).join('\n'),
  );
};

/** Kills a detached child's whole process group, so the `node -> tsx/vite` wrapper is not left holding the port. */
const killGroup = (child: ChildProcess): void => {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already gone, or never a group leader; either way there is nothing left to signal.
  }
};

/**
 * The spec process's own environment, minus anything that would point a child at the real database or a real port.
 *
 * The spec process inherits Playwright's environment, which is not the deployment's; every child this file spawns
 * is given this base and then this file's own values on top.
 */
const specProcessEnv = (): Record<string, string> => {
  const baseEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) baseEnv[key] = value;
  }
  for (const name of ['DATABASE_PATH', 'HOST', 'SERVER_PORT', 'JWT_SECRET', 'NODE_OPTIONS', 'NO_COLOR']) {
    delete baseEnv[name];
  }
  return baseEnv;
};

/**
 * Waits until `port` can be bound again, or fails naming the port it could not have.
 *
 * Both states' servers bind the one server port the shared client proxies to, so the second state's server starts
 * only once the first state's has stopped. A SIGKILLed listener is released at once on this platform, but "at
 * once" is not a guarantee the next bind may rely on: the bind is attempted here, bounded, so a port that is
 * genuinely still held ends the run by name instead of surfacing as a boot timeout further up the stack.
 */
const waitForPortFree = async (port: number): Promise<void> => {
  const deadline = Date.now() + CHILD_READY_TIMEOUT_MS;
  for (;;) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return;
    if (Date.now() >= deadline) {
      throw new Error(`port ${port} was still bound ${CHILD_READY_TIMEOUT_MS}ms after the previous state stopped`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

/** The ONE client both states are read through, plus the reading of what it was warm-started against. */
type SharedClient = {
  clientUrl: string;
  serverPort: number;
  stop: () => void;
};

/**
 * Boots the one Vite client the whole file reads through, its `/api` proxy pointed at the one server port both
 * states bind in turn.
 *
 * The two gate states differ only in the SERVER's `MCP_ENABLED`; the client is one and the same build of the
 * worktree's source, and the cases run serially, so at any moment only one server is listening on this port. A
 * second Vite for the second state bought nothing the first state's client had not already committed — and cost
 * the criterion its own cold dependency pre-bundle a second time (each state used to get a cache directory of its
 * own, so the second pre-bundle was cold), which measured as seconds of the run's wall clock under load.
 */
const bootSharedClient = async (serverPort: number, dataDir: string): Promise<SharedClient> => {
  const vitePort = runPort('QUAY_E2E_CLIENT_PORT') ?? await freePort();
  const viteLog: string[] = [];

  const vite = spawn(process.execPath, [VITE_BIN, '--host', '127.0.0.1', '--strictPort'], {
    cwd: REPO_ROOT,
    env: {
      ...specProcessEnv(),
      SERVER_PORT: String(serverPort),
      VITE_PORT: String(vitePort),
      HOST: '127.0.0.1',
      VITE_CACHE_DIR: path.join(dataDir, 'vite-cache'),
    },
    // stdin stays an OPEN pipe: the vite CLI exits the moment its stdin reaches EOF, and a closed stdin would kill
    // the dev server before the browser ever asked for a document.
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  vite.stdout?.on('data', (chunk) => viteLog.push(String(chunk)));
  vite.stderr?.on('data', (chunk) => viteLog.push(String(chunk)));

  await waitForHttp(`http://127.0.0.1:${vitePort}/`, () => viteLog.join(''));

  return { clientUrl: `http://127.0.0.1:${vitePort}`, serverPort, stop: () => killGroup(vite) };
};

/** One state's live backend on the shared client's port, plus the readings this criterion prints about it. */
type BootedState = {
  state: GateState;
  serverPort: number;
  clientUrl: string;
  /** The exact environment the server was spawned with, for the record the criterion writes out. */
  serverEnv: Record<string, string>;
  stop: () => void;
};

/**
 * Boots one gate state: a real API server, its own data dir and its own `MCP_ENABLED`, bound to the shared
 * client's fixed server port. The browser dials the client's origin, whose `/api` proxy forwards to this server, so
 * the page and its API calls share one origin exactly as they do in production.
 */
const bootState = async (state: GateState, dataDir: string, client: SharedClient): Promise<BootedState> => {
  const serverPort = client.serverPort;
  await waitForPortFree(serverPort);
  const serverLog: string[] = [];

  // Both keys the readings depend on are PINNED here, explicitly, for BOTH states — never left absent.
  //
  // `server/load-env.ts` backfills a key the child does not carry from `<repo root>/.env` (`!process.env[key]`),
  // so a deleted key is not "off": in a checkout whose `.env` pins `MCP_ENABLED=true` and a non-empty
  // `PUBLIC_BASE_URL`, the deleted value comes back, (b) reads a disabled state as "enabled", and (a) reads
  // the deployer's base url instead of this state's own origin. An explicit value wins the backfill, which is
  // what makes the two readings the criterion's own rather than the environment's.
  const serverEnv: Record<string, string> = {
    ...specProcessEnv(),
    DATABASE_PATH: path.join(dataDir, 'auth.db'),
    HOME: dataDir,
    CLAUDE_CONFIG_DIR: path.join(dataDir, 'claude-config'),
    HOST: '127.0.0.1',
    SERVER_PORT: String(serverPort),
    // The start-up sweep reaps every session scope on the host, not only this run's.
    CLAUDE_SESSION_SCOPE_SWEEP: 'off',
    FORCE_COLOR: '0',
    MCP_ENABLED: state.mcpEnabled,
    // `<base>/mcp` must resolve to THIS state's origin, so the base is pinned to the loopback the server binds
    // rather than inherited from a deployer's `.env` (which may advertise a public https origin).
    PUBLIC_BASE_URL: `http://127.0.0.1:${serverPort}`,
  };
  for (const key of READING_KEYS) {
    if (serverEnv[key] === undefined || serverEnv[key] === '') {
      throw new Error(
        `${key} is not pinned on the ${state.label} server env; server/load-env.ts would backfill it from the `
        + "deployer's .env, which is exactly the environment coupling this criterion must not depend on",
      );
    }
  }

  const server = spawn(process.execPath, [TSX_CLI, '--tsconfig', 'server/tsconfig.json', 'server/index.ts'], {
    cwd: REPO_ROOT,
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  server.stdout?.on('data', (chunk) => serverLog.push(String(chunk)));
  server.stderr?.on('data', (chunk) => serverLog.push(String(chunk)));

  await waitForHttp(`http://127.0.0.1:${serverPort}/health`, () => serverLog.join(''));

  return {
    state,
    serverPort,
    clientUrl: client.clientUrl,
    serverEnv,
    stop: () => killGroup(server),
  };
};

// ---------------------------------------------------------------------------
// Bounded startup guard
// ---------------------------------------------------------------------------

/**
 * A dependency the optimizer serves out of a state's private cache, already rewritten to its url.
 *
 * A 200 on this url only comes once the optimizer has committed the bundle, so warming on it means the page below
 * does not race a re-optimization that would serve it a superseded url.
 */
const OPTIMIZED_DEP_IN_TEXT = /["'](\/@fs\/[^"']*\/deps\/[^"']+\.js\?v=[0-9a-f]+)["']/;
/** How long a state's client is given to answer its app entry before the startup path gives up on it. */
const CLIENT_WARM_DEADLINE_MS = 30_000;
/** How long the landing of a navigation's *first* attempt is given on its own, before the guard starts replaying. */
const STARTUP_PROBE_MS = 8_000;
/** How long each bounded replay's landing is given. Shorter than the first: a replay is a re-ask, not a cold boot. */
const STARTUP_RELOAD_PROBE_MS = 3_000;
/** How long one navigation's single request is given before the guard treats it as a failed landing. */
const NAVIGATION_PROBE_MS = 8_000;
/**
 * How long the startup probe may spend proving a navigation landed, replays included.
 *
 * A deadline rather than a replay count, because it is the *sum* that has to stay inside the criterion's own wall
 * clock: a probe that cannot land must end the run inside this budget rather than let the case below wait out its
 * own 30s on a blank page. Counting replays leaves that head-room to chance; a deadline spends it.
 */
const STARTUP_PROBE_DEADLINE_MS = 14_000;

/**
 * Takes one state's first dependency optimization out of the measurement window: the shell, the app entry and one
 * optimized dependency, all requested against that state's own client before its page exists.
 *
 * Each state has its own `VITE_CACHE_DIR`, and Vite is guaranteed to rewrite its cache — without this the first
 * navigation would race the optimizer's own re-optimization, which swaps the `browserHash` baked into every
 * dependency url out from under a page already holding the old one (`504 Outdated Optimize Dep`). A 200 on the
 * dependency url only comes once the bundle is committed, so the page below does not race it.
 *
 * Every step is bounded, including each request: a client that accepts the connection and then never answers fails
 * here, by name, with the url — rather than waiting out a timeout further up the stack.
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

  let lastAnswer = 'no dependency url was ever served';
  for (let attempt = 0; attempt < 5 && Date.now() < deadline; attempt += 1) {
    const specifier = OPTIMIZED_DEP_IN_TEXT.exec(await (await fetchWithin(entryUrl)).text())?.[1];
    if (!specifier) break;
    const depUrl = new URL(specifier, clientUrl).href;
    const dep = await fetchWithin(depUrl);
    if (dep.ok) {
      console.log(`[e2e] client warm-up (${clientUrl}): pre-bundle committed in ${Date.now() - startedAt}ms`);
      return Date.now() - startedAt;
    }
    lastAnswer = `${depUrl} answered HTTP ${dep.status}`;
    await dep.text().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `this state's dependency pre-bundle never committed, so the criterion cannot drive a document that stays: `
    + lastAnswer,
  );
};

/** Whether `locator` showed up within `timeoutMs`. */
const appears = async (locator: Locator, timeoutMs: number): Promise<boolean> =>
  locator.waitFor({ state: 'visible', timeout: timeoutMs }).then(
    () => true,
    () => false,
  );

/**
 * What a guarded navigation is expected to land on — and how the guard names it when it never lands.
 *
 * `present` and `label` are functions rather than values because both are read at attempt time: the locator has to
 * be re-created against whatever document is current *now*, after a replay has replaced the one the navigation
 * started on.
 */
type StartupLanding = {
  /** Names this landing in the guard's own error, so a red says which document never came up. */
  readonly label: () => string;
  /** Whether the landing is on screen right now, within `budgetMs`. */
  readonly present: (budgetMs: number) => Promise<boolean>;
};

/** What the startup page said, kept for one purpose: a startup red has to explain a document pulled out from under a navigation. */
type StartupEvidence = {
  consoleErrors: string[];
  failedRequests: string[];
};

/** The startup page's own text plus this run's console and network evidence — what a startup red is read from. */
const readStartupEvidence = async (page: Page, evidence: StartupEvidence): Promise<string> => {
  const shown = await page.locator('body').innerText().catch(() => '<unreadable>');
  const errors = evidence.consoleErrors.slice(0, 5);
  const failed = evidence.failedRequests.slice(0, 5);
  return `the page shows ${JSON.stringify(shown.slice(0, 300))}`
    + `; console errors: ${errors.length > 0 ? errors.join(' | ') : '<none>'}`
    + `; failed requests: ${failed.length > 0 ? failed.join(' | ') : '<none>'}`;
};

/**
 * The one place this spec navigates — every `page.goto`/`page.reload` in this file is inside this function, which is
 * what makes "every navigation is guarded" a property of the file rather than a habit of its call site.
 *
 * One pass is: navigate to this state's own client, then probe the landing with a short budget. A landing that does
 * not arrive has the navigation replayed — a fresh document, which is exactly what recovers from in-flight module
 * requests that were interrupted once (the host's `net::ERR_NETWORK_CHANGED`) — and the probe repeated, until the
 * deadline. When the deadline is spent the guard throws with the page's own text and the failed-request list, never
 * silently continuing: a probe that cannot land must end the run here, with a cause, rather than let the case wait
 * out its own 30s on a document with nothing in it.
 *
 * The navigation itself is bounded too, and a navigation that times out is treated as a landing that did not arrive
 * rather than as an error of its own: a document that never finishes loading and a document that loads without ever
 * mounting are the same failure from here, and both end at the same named error.
 */
const navigateBounded = async (
  page: Page,
  clientUrl: string,
  landing: StartupLanding,
  evidence: StartupEvidence,
): Promise<void> => {
  const startedAt = Date.now();
  const deadline = startedAt + STARTUP_PROBE_DEADLINE_MS;
  const budgetMs = () => Math.max(1, deadline - Date.now());
  let navigationFailure: string | null = null;
  for (let attempt = 1; ; attempt += 1) {
    try {
      if (attempt === 1) {
        await page.goto(clientUrl, {
          waitUntil: 'domcontentloaded',
          timeout: Math.min(NAVIGATION_PROBE_MS, budgetMs()),
        });
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
        + `: ${await readStartupEvidence(page, evidence)}`,
      );
    }
  }
};

// ---------------------------------------------------------------------------
// Page plumbing
// ---------------------------------------------------------------------------

/** Runs the fresh-database first-run setup so the app shell is reachable; tolerant of an already-set-up account. */
const reachAppShell = async (page: Page): Promise<void> => {
  await expect(page.locator('#username')).toBeVisible({ timeout: LANDING_TIMEOUT_MS });
  await page.locator('#username').fill('e2euser');
  await page.locator('input[type=password]').nth(0).fill('e2epassword');
  await page.locator('input[type=password]').nth(1).fill('e2epassword');
  await page.getByRole('button', { name: 'Create Account' }).click();
  await page.getByPlaceholder('John Doe').fill('E2E User');
  await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Complete Setup' }).click();
  await expect(page.getByRole('button', { name: 'Settings', exact: true }).first()).toBeVisible({
    timeout: LANDING_TIMEOUT_MS,
  });
};

/** Opens Settings → "API & Tokens" and waits for the token section, so the whole tab has finished its first read. */
const openApiTokensTab = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'API & Tokens', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Personal Access Tokens' })).toBeVisible({ timeout: 15_000 });
};

/** Every text node of the document, joined — the whole-page surface the token-leak scan reads. */
const readAllTextNodes = (page: Page): Promise<string> => page.evaluate(() => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  while (walker.nextNode()) {
    parts.push(walker.currentNode.nodeValue ?? '');
  }
  return parts.join('\n');
});

/**
 * What the first navigation must land on: the fresh database's account form, or the app shell's Settings button in
 * the tolerant case where this state's database already carries an account. Either proves the document mounted —
 * the property the guard is about — and not that a particular read happened to arrive.
 */
const firstLanding = (page: Page): StartupLanding => ({
  label: () => 'the account form or the app shell',
  present: async (budgetMs) => {
    // One budget for BOTH probes, or a blank page spends the whole probe window on the first probe and the guard
    // reaches its deadline without ever replaying — the one thing the deadline exists to leave room for.
    const startedAt = Date.now();
    if (await appears(page.locator('#username'), budgetMs)) return true;
    const remainingMs = Math.max(1, budgetMs - (Date.now() - startedAt));
    return appears(page.getByRole('button', { name: 'Settings', exact: true }).first(), remainingMs);
  },
});

/**
 * Boots one state in a fresh browser context seeded with a fresh data directory, read through the shared client.
 *
 * The client's pre-bundle was committed once, in `test.beforeAll`, before any page existed — so this helper does
 * no warm-up of its own. A fresh context per state is what keeps the two states apart where the DB cannot: the
 * client's origin is the same one for both, so the browser storage has to be fresh, or the account the first
 * state created would be sent to the second state's server (which has its own, empty database).
 *
 * `preBooted` is the state's server when `test.beforeAll` already started it (the disabled state, whose boot
 * overlaps the client warm-up — see there). Nothing is booted twice: that server's own data directory came with it.
 */
const bootStateWithPage = async (
  browser: Browser,
  state: GateState,
  client: SharedClient,
  preBooted?: BootedState,
): Promise<{
  booted: BootedState;
  page: Page;
  close: () => Promise<void>;
}> => {
  const booted = preBooted ?? await bootState(
    state,
    fs.mkdtempSync(path.join(process.env.QUAY_E2E_DATA_DIR ?? '/tmp', `mcp-settings-${state.label}-`)),
    client,
  );

  const context = await browser.newContext();
  const page = await context.newPage();
  const evidence: StartupEvidence = { consoleErrors: [], failedRequests: [] };
  // What the page said, kept for one purpose: the startup guard has to *explain* a document pulled out from under a
  // navigation instead of reporting that a wait ran out. Registered before the first navigation, or the burst that
  // matters (the interrupted module requests) would not be in the evidence.
  page.on('console', (message) => {
    if (message.type() === 'error') evidence.consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    evidence.failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? 'no error text'}`);
  });

  // The startup navigation is the guard's, not this helper's call site: it lands on the fresh database's account
  // form, or it ends the run with the page's own evidence instead of letting the 30s `#username` wait below run out.
  await navigateBounded(page, booted.clientUrl, firstLanding(page), evidence);
  await reachAppShell(page);
  return {
    booted,
    page,
    close: async () => {
      await context.close();
      booted.stop();
    },
  };
};

test.describe.configure({ mode: 'serial', timeout: 110_000 });

/** The one client the file's two states are read through. Booted in `test.beforeAll`, torn down in `test.afterAll`. */
let sharedClient: SharedClient | null = null;
/** The disabled state's server, booted in `test.beforeAll` alongside the client's single warm-up (see there). */
let preBootedDisabled: BootedState | null = null;

/** The shared client, or a failure naming the reason there is none rather than a bare "cannot read property". */
const requireSharedClient = (): SharedClient => {
  if (sharedClient === null) {
    throw new Error('the shared client is not booted; test.beforeAll must have failed before the first case ran');
  }
  return sharedClient;
};

/** Hands over the pre-booted disabled state once, so the reference cannot be reused after its own case closed it. */
const takePreBootedDisabled = (): BootedState => {
  const booted = preBootedDisabled;
  if (booted === null) {
    throw new Error('the disabled state was not pre-booted; test.beforeAll must have failed before the first case ran');
  }
  preBootedDisabled = null;
  return booted;
};

/**
 * Records this checkout's own `.env` key names once, at the top of the run, and boots the ONE client both states
 * are read through — including its single warm-up, taken before any page exists.
 *
 * The readings themselves are pinned (see `READING_KEYS`), so those values cannot decide a reading — but the
 * NAMES being visible is what turns a future `.env` change from a silent flip into something the run's output
 * shows. `(none)` is the normal case for a checkout with no `.env`: nothing for `load-env.ts` to backfill.
 *
 * The server port is fixed here, once, and both states bind it in turn. The client is warmed here rather than per
 * state because both states share it: a second cold pre-bundle is exactly the wall clock this file removes. The
 * disabled state's own server boot is overlapped with that warm-up (below) for the same reason — it is a full boot
 * the run would otherwise pay for serially.
 *
 * Both ports are this RUN's published pair — the ones the config left unstarted for this selection and the watchdog
 * probes (see `runPort`), not a fresh kernel-assigned pair.
 */
test.beforeAll(async () => {
  const keys = readDotenvKeys();
  console.log(
    `dotenv-keys=${keys.length > 0 ? keys.join(',') : '(none)'}; `
    + `reading keys pinned explicitly on every state=${READING_KEYS.join(',')}`,
  );

  const serverPort = runPort('QUAY_E2E_SERVER_PORT') ?? await freePort();
  const sharedDataDir = fs.mkdtempSync(path.join(process.env.QUAY_E2E_DATA_DIR ?? '/tmp', 'mcp-settings-shared-'));
  const client = await bootSharedClient(serverPort, sharedDataDir);

  // The disabled state's server is booted *alongside* the client's one warm-up, not after it. The two waits are
  // independent — the pre-bundle needs no server, and the server needs no pre-bundle — and this is one of the two
  // server boots the file pays in full, so overlapping it is wall clock taken off the run rather than moved around
  // it. The enabled state's server cannot join: both bind the shared server port, so it still starts only after the
  // first case has closed this one.
  const disabledDataDir = fs.mkdtempSync(path.join(process.env.QUAY_E2E_DATA_DIR ?? '/tmp', 'mcp-settings-disabled-'));
  const [warmMs, disabled] = await Promise.all([
    warmClientStartup(client.clientUrl),
    bootState(DISABLED_STATE, disabledDataDir, client),
  ]);
  console.log(
    `[e2e] shared client ${client.clientUrl} -> server port ${serverPort}; pre-bundle committed in ${warmMs}ms; `
    + 'disabled state booted alongside it',
  );
  sharedClient = client;
  preBootedDisabled = disabled;
});

test.afterAll(() => {
  // Only set when `test.beforeAll` succeeded and the disabled case never took it (a failure or a skipped run), so
  // this is the cleanup for the stack that would otherwise be left holding the shared server port.
  preBootedDisabled?.stop();
  preBootedDisabled = null;
  sharedClient?.stop();
  sharedClient = null;
});

test.describe('CloudCLI MCP block and token scopes in settings', () => {
  test('(b) disabled state: the page shows "not enabled" and renders no connect command', async ({ browser }) => {
    const { booted, page, close } = await bootStateWithPage(
      browser,
      DISABLED_STATE,
      requireSharedClient(),
      takePreBootedDisabled(),
    );
    try {
      await openApiTokensTab(page);

      const status = page.getByTestId('mcp-gateway-status');
      await expect(status).toHaveAttribute('data-enabled', 'false');
      const statusText = (await status.innerText()).trim();

      const hint = page.getByTestId('mcp-gateway-enable-hint');
      await expect(hint).toBeVisible();
      const hintText = (await hint.innerText()).trim();

      const commandCount = await page.getByTestId('mcp-gateway-command').count();
      const bodyText = await page.locator('body').innerText();
      const bearerOnPage = bodyText.includes('Bearer');

      console.log(
        `(b) server env MCP_ENABLED=${JSON.stringify(booted.serverEnv.MCP_ENABLED)} `
        + `PUBLIC_BASE_URL=${JSON.stringify(booted.serverEnv.PUBLIC_BASE_URL)}; status node="${statusText}" `
        + `(data-enabled=${await status.getAttribute('data-enabled')}); enable hint="${hintText}"; `
        + `connect-command nodes=${commandCount}; "Bearer" anywhere on page=${bearerOnPage}`,
      );

      expect(statusText.length).toBeGreaterThan(0);
      expect(hintText.length).toBeGreaterThan(0);
      expect(commandCount).toBe(0);
      expect(bearerOnPage).toBe(false);
    } finally {
      await close();
    }
  });

  test('(a)(c)(d)(e) enabled state: endpoint, copy button, safe command, scope checkboxes and token-info scopes', async ({ browser }) => {
    const { booted, page, close } = await bootStateWithPage(browser, ENABLED_STATE, requireSharedClient());
    try {
      await openApiTokensTab(page);

      // (a) The enabled reading: status, endpoint url and a copy button, all really on screen.
      const status = page.getByTestId('mcp-gateway-status');
      await expect(status).toHaveAttribute('data-enabled', 'true');
      const statusText = (await status.innerText()).trim();

      const endpointNode = page.getByTestId('mcp-gateway-endpoint');
      await expect(endpointNode).toBeVisible();
      const endpointText = (await endpointNode.innerText()).trim();

      const copyButton = page.getByTestId('mcp-gateway-copy');
      const copyVisible = await copyButton.isVisible();

      console.log(
        `(a) server env MCP_ENABLED=${JSON.stringify(booted.serverEnv.MCP_ENABLED)} `
        + `PUBLIC_BASE_URL=${JSON.stringify(booted.serverEnv.PUBLIC_BASE_URL)}; status node="${statusText}" `
        + `(data-enabled=${await status.getAttribute('data-enabled')}); endpoint="${endpointText}"; `
        + `copy button visible=${copyVisible}`,
      );

      expect(statusText.length).toBeGreaterThan(0);
      expect(copyVisible).toBe(true);
      // `<base>/mcp`, where the base is this state's own server origin: the Vite `/api` proxy forwards the request
      // to the server, so the origin the server reports is the address an MCP client should dial.
      expect(endpointText).toMatch(/^https?:\/\/[^/]+\/mcp$/);
      expect(Number(new URL(endpointText).port)).toBe(booted.serverPort);

      // (c) The connect command carries the endpoint and a Bearer placeholder — never a real token.
      const commandNode = page.getByTestId('mcp-gateway-command');
      await expect(commandNode).toBeVisible();
      const commandText = (await commandNode.innerText()).trim();
      console.log(`(c) connect command = ${JSON.stringify(commandText)}`);
      expect(commandText).toContain(endpointText);
      expect(commandText).toMatch(/Authorization:\s*Bearer\s*<token>/);

      // (d) Five scope checkboxes: only the read baseline starts checked; the risk note appears on the first write scope.
      await page.getByRole('button', { name: 'New Token', exact: true }).click();
      const boxFor = (scope: string) =>
        page.locator(`[data-testid="access-token-scope"][data-scope="${scope}"]`);
      const initialChecked: Record<string, boolean> = {};
      for (const scope of SCOPE_VOCABULARY) {
        initialChecked[scope] = await boxFor(scope).isChecked();
      }
      const riskNote = page.getByTestId('access-token-scope-risk');
      const riskBefore = await riskNote.count();

      await boxFor('cloudcli:session:send').check();
      await expect(riskNote).toBeVisible();
      const riskAfter = await riskNote.count();

      console.log(
        `(d) initial checked=${JSON.stringify(initialChecked)}; risk note before=${riskBefore} `
        + `after checking cloudcli:session:send=${riskAfter}; risk text="${(await riskNote.innerText()).trim()}"`,
      );

      expect(initialChecked['cloudcli:read']).toBe(true);
      for (const scope of SCOPE_VOCABULARY.slice(1)) {
        expect(initialChecked[scope]).toBe(false);
      }
      expect(riskBefore).toBe(0);
      expect(riskAfter).toBe(1);

      // (e) A multi-scope positive: create a token with the read baseline plus two write scopes.
      await boxFor('cloudcli:session:create').check();
      const selectedScopes = ['cloudcli:read', 'cloudcli:session:send', 'cloudcli:session:create'];
      const tokenName = `e2e-mcp-${Date.now()}`;
      await page.getByPlaceholder('Token name (e.g., My MCP client)').fill(tokenName);
      await page.getByTestId('access-token-expiry').selectOption('30');

      const [createResponse] = await Promise.all([
        page.waitForResponse((response) =>
          response.request().method() === 'POST' && response.url().endsWith('/api/settings/access-tokens')),
        page.getByRole('button', { name: 'Create token', exact: true }).click(),
      ]);
      const plaintext = (await page.getByTestId('new-access-token-plaintext').innerText()).trim();
      expect(createResponse.status()).toBe(201);

      // Dismiss the one-time plaintext card so the scan below measures the page as it stands after the token exists.
      await page.getByRole('button', { name: "I've saved it" }).click();
      await expect(page.getByTestId('new-access-token-plaintext')).toHaveCount(0);

      const pageText = await readAllTextNodes(page);
      const leakedHits = pageText.split(plaintext).length - 1;
      console.log(
        `(c) dismissed the one-time card; real token hits across ALL page text nodes = ${leakedHits} `
        + `(token prefix ${plaintext.slice(0, 8)})`,
      );
      expect(leakedHits).toBe(0);

      const tokenInfo = await httpRequest(
        'GET',
        `http://127.0.0.1:${booted.serverPort}/api/oauth/token-info`,
        { authorization: `Bearer ${plaintext}` },
      );
      const info = JSON.parse(tokenInfo.body) as { userId?: number; scopes?: string[]; expiresAt?: string };
      console.log(
        `(e) checked scopes=${JSON.stringify(selectedScopes)}; GET /api/oauth/token-info -> ${tokenInfo.status} `
        + `scopes=${JSON.stringify(info.scopes)} userId=${info.userId} expiresAt=${info.expiresAt}`,
      );
      expect(tokenInfo.status).toBe(200);
      expect([...(info.scopes ?? [])].sort()).toEqual([...selectedScopes].sort());
    } finally {
      await close();
    }
  });
});
