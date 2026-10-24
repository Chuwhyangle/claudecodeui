/**
 * The architecture tab's manual re-analysis, in real browsers.
 *
 * WHY THIS FILE EXISTS. The feature is a server-side child process, a shared
 * status reading and a confirmation dialog, and none of those can be judged by
 * unit tests alone:
 *
 *  · the footer's Refresh entry opens a confirmation dialog; Cancel sends no
 *    request and Escape only closes the dialog (the chat page owns Escape for
 *    aborting a turn, so an Escape that leaks would be visible here as a second
 *    handler — the unit criterion pins the event, this one pins the UI path);
 *  · a running job shows its elapsed time, disables the entry, and a tab opened
 *    MID-RUN shows the shared running state without a second start door;
 *  · two pages pressing Refresh at the same moment produce ONE CLI invocation
 *    (the counter file is the reading, not the 202 body);
 *  · success refetches the graph: the footer's analysis time moves, the
 *    previously-unresolved name is found, and the drawing is fitted again;
 *  · failure keeps the live analysis byte-for-byte and shows the reason + Retry.
 *
 * THE FAKE CLI. `playwright.config.ts` writes a stand-in ArchGuard CLI, a
 * counter file, a control file and this selection's server settings file. The
 * server finds the CLI through the production `architecture.refresh.cliPath`
 * knob, so the feature's own resolution path is exercised; the CLI itself writes
 * the same `query/` shape and can be told to sleep or fail through the control
 * file. No real analysis runs here.
 *
 * THE CONTROL ARM removes the two mechanisms and reads the SAME evidence
 * function: with single-flight gone, two presses must produce TWO invocations;
 * with staging gone, a failed run must change the live manifest. Both readings
 * going the other way is what makes the main arm's green mean something.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { expect, request, test } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';

import { awaitClientMounted, warmClientStartup, type RequestFailure } from './support/client-startup-warmup';

const RUN_STARTED_AT = Number(process.env.QUAY_E2E_RUN_STARTED_AT) || Date.now();

test.describe.configure({ timeout: 180_000 });

const VIEWPORT_PC = { width: 1440, height: 765 };
const USERNAME = 'architecture-refresh-e2e';
const PASSWORD = 'architecture-refresh-e2e-pass';
const WORKSPACE_DIR = 'architecture-refresh-workspace';

const SCOPE_KEY = 'aaaa0001';
const OLD_GENERATED_AT = '2026-01-01T00:00:00.000Z';
const SEED_NAME = 'Alpha';
const UNRESOLVED_NAME = 'Delta';

const SHOTS_DIR = path.resolve(process.cwd(), 'tmp', 'architecture-refresh');

const SEL = {
  panel: '[data-architecture-panel]',
  graphRoot: '[data-architecture-plantuml-graph]',
  host: '[data-architecture-plantuml]',
  node: '.uml-node[data-entity-id]',
  footerRefresh: '[data-architecture-refresh]',
  unresolvedToggle: '[data-architecture-unresolved]',
  unresolvedRefresh: '[data-architecture-refresh-unresolved]',
  dialog: '[data-architecture-refresh-dialog]',
  dialogConfirm: '[data-architecture-refresh-confirm]',
  dialogCancel: '[data-architecture-refresh-cancel]',
  dialogElapsed: '[data-architecture-refresh-elapsed]',
  dialogError: '[data-architecture-refresh-error]',
  zoomIn: '[data-architecture-zoom-in]',
  zoomMode: '[data-architecture-zoom-mode]',
  architectureTab: '[role="tab"][data-workspace-tab="architecture"]',
} as const;

/* ── the run's own paths (published by playwright.config.ts) ─────────────────────────────── */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`playwright.config.ts must publish ${name} for architecture-refresh.spec.ts`);
  }
  return value;
}

const SETTINGS_PATH = requireEnv('QUAY_E2E_ARCHITECTURE_REFRESH_SETTINGS');
const COUNTER_PATH = requireEnv('QUAY_E2E_ARCHITECTURE_REFRESH_COUNTER');
const CONTROL_PATH = requireEnv('QUAY_E2E_ARCHITECTURE_REFRESH_CONTROL');
const CLI_PATH = requireEnv('QUAY_E2E_ARCHITECTURE_REFRESH_CLI');

let settingsBump = 0;

/** Rewrites the job's `defect` through the production settings file (mtime-re-read). */
function setDefect(defect: '' | 'no-coalesce' | 'no-preserve'): void {
  const document = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) as {
    architecture: { refresh: Record<string, unknown> };
  };
  document.architecture.refresh.defect = defect;
  document.architecture.refresh.cliPath = CLI_PATH;
  fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  // Force a strictly newer stamp so the reader's mtime cache cannot answer the
  // previous arm's reading.
  settingsBump += 1;
  const stamp = new Date(Date.now() + settingsBump * 1_000);
  fs.utimesSync(SETTINGS_PATH, stamp, stamp);
}

function writeControl(mode: 'success' | 'fail', delayMs: number): void {
  fs.writeFileSync(CONTROL_PATH, JSON.stringify({ mode, delayMs }), 'utf8');
}

function resetCounter(): void {
  fs.writeFileSync(COUNTER_PATH, '', 'utf8');
}

function counterCount(): number {
  try {
    return fs.readFileSync(COUNTER_PATH, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    return 0;
  }
}

function liveManifestPath(): string {
  return path.join(workspace, '.archguard', 'query', 'manifest.json');
}

function liveManifestHash(): string {
  return createHash('sha256').update(fs.readFileSync(liveManifestPath())).digest('hex');
}

/* ── the fixture ─────────────────────────────────────────────────────────────────────────── */

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * The project's analysis BEFORE any refresh: Alpha and Beta are indexed; the
 * session also mentions Delta, which is not — so the honest bar shows one
 * unresolved name. The fake CLI's successful run adds Delta, which is the
 * "unresolved names drop" reading.
 */
function writeFixture(workspaceDir: string): void {
  const srcDir = path.join(workspaceDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'alpha.ts'), 'export class Alpha {}\n', 'utf8');

  const entities = [
    { id: 'src/alpha.ts.Alpha', name: 'Alpha', file: 'src/alpha.ts', kind: 'class', dependsOn: [] as string[] },
    { id: 'src/alpha.ts.Beta', name: 'Beta', file: 'src/alpha.ts', kind: 'class', dependsOn: ['src/alpha.ts.Alpha'] },
  ];
  const fileToIds: Record<string, string[]> = {};
  const nameToIds: Record<string, string[]> = {};
  const idToFile: Record<string, string> = {};
  const idToName: Record<string, string> = {};
  const dependencies: Record<string, string[]> = {};
  const dependents: Record<string, string[]> = {};
  for (const entity of entities) {
    (fileToIds[entity.file] ??= []).push(entity.id);
    (nameToIds[entity.name] ??= []).push(entity.id);
    idToFile[entity.id] = entity.file;
    idToName[entity.id] = entity.name;
    dependencies[entity.id] = [];
    dependents[entity.id] = [];
  }
  for (const entity of entities) {
    for (const parent of entity.dependsOn) {
      dependencies[parent]?.push(entity.id);
      dependents[entity.id]?.push(parent);
    }
  }

  // Delta is KNOWN to the name index but has no entity detail: the transcript's
  // mention is a seed the server cannot resolve, which is exactly the honest
  // bar's "names … not found in the analysis cache" reading. The fake CLI's
  // successful run adds the complete entity, so the count drops to zero.
  nameToIds[UNRESOLVED_NAME] = ['src/delta.ts.Delta'];

  const queryDir = path.join(workspaceDir, '.archguard', 'query');
  writeJson(path.join(queryDir, 'manifest.json'), {
    version: '1.0',
    generatedAt: OLD_GENERATED_AT,
    globalScopeKey: SCOPE_KEY,
    scopes: [{ key: SCOPE_KEY, label: 'src (typescript)', language: 'typescript', sources: [srcDir] }],
  });
  writeJson(path.join(queryDir, SCOPE_KEY, 'arch-index.json'), {
    version: '1.0',
    language: 'typescript',
    archJsonHash: 'old-hash',
    generatedAt: OLD_GENERATED_AT,
    fileToIds,
    nameToIds,
    idToFile,
    idToName,
    dependencies,
    dependents,
  });
  writeJson(path.join(queryDir, SCOPE_KEY, 'arch.json'), {
    version: '1.0',
    language: 'typescript',
    entities: entities.map((entity) => ({
      id: entity.id,
      name: entity.name,
      type: entity.kind,
      isAbstract: false,
      members: [],
    })),
  });
}

/* ── the server's own faces ──────────────────────────────────────────────────────────────── */

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

async function armScenario(api: APIRequestContext, projectPath: string): Promise<string> {
  const scenario = {
    version: 1,
    dialect: 'claude',
    home: 'gate',
    transcript: { mode: 'per-row-jsonl' },
    seed: {
      title: 'Architecture refresh',
      userText: `Please review \`${SEED_NAME}\` and \`${UNRESOLVED_NAME}\` before the refactor.`,
    },
    steps: [{ at: 0, op: 'wait' }],
    expect: { rows: { delta: 0 }, content: { mustContain: [SEED_NAME] } },
  };
  const response = await api.post('/api/debug-agent/scenarios', { data: { projectPath, scenario } });
  const body = await response.json().catch(() => null);
  if (!response.ok()) throw new Error(`arming failed (${response.status()}): ${JSON.stringify(body)}`);
  const sessionId = body?.data?.sessionId;
  if (typeof sessionId !== 'string') throw new Error(`arming returned no sessionId: ${JSON.stringify(body)}`);
  return sessionId;
}

/* ── page setup ─────────────────────────────────────────────────────────────────────────── */

type StartupEvidence = {
  pageErrors: string[];
  consoleErrors: string[];
  requestFailures: RequestFailure[];
  warmup: null;
};

const startupEvidence: StartupEvidence = {
  pageErrors: [],
  consoleErrors: [],
  requestFailures: [],
  warmup: null,
};

let warmClientPromise: Promise<unknown> | null = null;

function attachEvidence(page: Page): void {
  page.on('pageerror', (error) => startupEvidence.pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') startupEvidence.consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request_) => {
    startupEvidence.requestFailures.push({
      url: request_.url(),
      failureText: request_.failure()?.errorText ?? 'no error text',
    });
  });
}

async function openContext(browser: Browser, baseURL: string, token: string): Promise<BrowserContext> {
  const dataDir = process.env.QUAY_E2E_DATA_DIR;
  if (!dataDir) throw new Error('playwright.config.ts must publish QUAY_E2E_DATA_DIR');
  warmClientPromise ??= warmClientStartup(baseURL, dataDir);
  const context = await browser.newContext({ baseURL, viewport: VIEWPORT_PC });
  await context.addInitScript(
    ({ authKey, authToken }: { authKey: string; authToken: string }) => {
      window.localStorage.setItem(authKey, authToken);
      window.localStorage.setItem('userLanguage', 'en');
    },
    { authKey: 'auth-token', authToken: token },
  );
  return context;
}

async function newEvidencePage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  attachEvidence(page);
  return page;
}

async function settle(page: Page, ms = 300): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await page.waitForTimeout(ms);
}

async function waitForDiagram(page: Page): Promise<void> {
  await page.waitForFunction(
    ({ root, host, node }) => {
      const graphRoot = document.querySelector(root);
      const hostElement = document.querySelector(host);
      return Number(graphRoot?.getAttribute('data-architecture-visible-nodes') ?? '0') > 0
        && (hostElement?.querySelectorAll(node).length ?? 0) > 0;
    },
    { root: SEL.graphRoot, host: SEL.host, node: SEL.node },
    { timeout: 40_000 },
  );
  await settle(page, 500);
}

async function enterArchitecture(page: Page): Promise<void> {
  const tab = page.locator(SEL.architectureTab);
  await expect(tab, 'the fixture project offers the architecture tab').toBeVisible({ timeout: 30_000 });
  await tab.first().click();
  await expect(page.locator(`[data-workspace-view="architecture"] ${SEL.panel}`)).toBeVisible({ timeout: 30_000 });
  await waitForDiagram(page);
}

async function openPage(page: Page, sessionId: string): Promise<void> {
  await page.goto(`/session/${sessionId}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await awaitClientMounted(page, SEL.architectureTab, 25_000, startupEvidence);
  await enterArchitecture(page);
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
}

/* ── the evidence function both arms share ─────────────────────────────────────────────── */

type RefreshEvidence = {
  footerState: string | null;
  footerDisabled: boolean;
  footerElapsed: string | null;
  generatedAt: string | null;
  unresolved: number;
  zoomMode: string | null;
  dialogPhase: string | null;
  dialogElapsed: string | null;
  dialogError: string | null;
  confirmDisabled: boolean;
  counter: number;
  manifestHash: string;
};

async function readRefreshEvidence(page: Page): Promise<RefreshEvidence> {
  const dom = await page.evaluate((sel) => {
    const footer = document.querySelector(sel.footerRefresh) as HTMLButtonElement | null;
    const generated = document.querySelector('[data-architecture-generated-at]');
    const unresolved = document.querySelector(sel.unresolvedToggle);
    const zoom = document.querySelector(sel.zoomMode);
    const dialog = document.querySelector(sel.dialog);
    const elapsed = document.querySelector(sel.dialogElapsed);
    const error = document.querySelector(sel.dialogError);
    const confirm = document.querySelector(sel.dialogConfirm) as HTMLButtonElement | null;
    return {
      footerState: footer?.getAttribute('data-architecture-refresh-state') ?? null,
      footerDisabled: footer?.disabled ?? false,
      footerElapsed: footer?.querySelector('[data-architecture-refresh-footer-elapsed]')?.textContent ?? null,
      generatedAt: generated?.getAttribute('datetime') ?? generated?.textContent ?? null,
      unresolved: Number(unresolved?.getAttribute('data-architecture-unresolved') ?? 'NaN'),
      zoomMode: zoom?.getAttribute('data-architecture-zoom-mode') ?? null,
      dialogPhase: dialog?.getAttribute('data-architecture-refresh-phase') ?? null,
      dialogElapsed: elapsed?.textContent ?? null,
      dialogError: error?.textContent ?? null,
      confirmDisabled: confirm?.disabled ?? false,
    };
  }, SEL);
  return {
    ...dom,
    counter: counterCount(),
    manifestHash: liveManifestHash(),
  };
}

/** Opens the confirmation dialog from the footer entry. */
async function openRefreshDialog(page: Page): Promise<void> {
  const footer = page.locator(SEL.footerRefresh);
  await expect(footer).toBeEnabled({ timeout: 10_000 });
  await footer.click();
  await expect(page.locator(SEL.dialog)).toBeVisible({ timeout: 10_000 });
}

/** Confirms the dialog's primary action (Refresh / Retry). */
async function confirmRefresh(page: Page): Promise<void> {
  await page.locator(SEL.dialogConfirm).click();
}

/* ── the run ───────────────────────────────────────────────────────────────────────────── */

let baseURL = '';
let token = '';
let sessionId = '';
let workspace = '';

test.beforeAll(async () => {
  baseURL = test.info().project.use.baseURL ?? '';
  if (baseURL === '') throw new Error('playwright.config.ts must give this project a baseURL');
  const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
  if (!fixtureHome) {
    throw new Error(
      'playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME for this selection '
        + '(the spec is listed in DEBUG_AGENT_SPEC_FILES)',
    );
  }
  workspace = path.join(fixtureHome, WORKSPACE_DIR);
  writeFixture(workspace);
  resetCounter();
  writeControl('success', 0);
  setDefect('');

  const bootstrap = await request.newContext({ baseURL });
  token = await createAccount(bootstrap);
  await bootstrap.dispose();

  const api = await request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  sessionId = await armScenario(api, workspace);
  await api.dispose();

  console.log(`[architecture-refresh] session=${sessionId} workspace=${workspace}`);
});

test('manual refresh: confirm, coalesce, run, refetch and fail without touching the live analysis', async ({ browser }) => {
  const context = await openContext(browser, baseURL, token);
  try {
    // A run long enough that a THIRD page can finish booting and mounting the
    // tab while the job is still live. The control arm's 2 s is shorter because
    // it only needs the two presses to overlap.
    writeControl('success', 8_000);
    resetCounter();
    setDefect('');

    // 1. Two pages on the architecture tab, plus the baseline reading.
    const first = await newEvidencePage(context);
    const second = await newEvidencePage(context);
    await openPage(first, sessionId);
    await openPage(second, sessionId);
    const before = await readRefreshEvidence(first);
    expect(before.generatedAt).toBe(OLD_GENERATED_AT);
    expect(before.unresolved, 'Delta is not in the analysis yet').toBe(1);
    expect(before.footerState).toBe('idle');
    expect(before.counter).toBe(0);
    await shot(first, '01-baseline');

    // A manual zoom is the reader's; the auto Fit after a successful refresh must
    // replace it, so establish "custom" before the refresh.
    await first.locator(SEL.zoomIn).click();
    await expect
      .poll(async () => (await readRefreshEvidence(first)).zoomMode, { timeout: 5_000 })
      .toBe('custom');

    // 2. Cancel sends nothing; Escape closes only the dialog.
    await openRefreshDialog(first);
    await expect(first.locator(SEL.dialog)).toContainText('re-analyse the whole project');
    await expect(first.locator(SEL.dialog)).toContainText('other tabs or sessions');
    await shot(first, '02-confirm-dialog');
    await first.locator(SEL.dialogCancel).click();
    await expect(first.locator(SEL.dialog)).toHaveCount(0);
    expect(counterCount(), 'Cancel must not start an analysis').toBe(0);

    await openRefreshDialog(first);
    await first.keyboard.press('Escape');
    await expect(first.locator(SEL.dialog)).toHaveCount(0);
    expect(counterCount(), 'Escape must not start an analysis').toBe(0);

    // 3. Confirm: the run is live, shows elapsed time, and disables the start.
    await openRefreshDialog(first);
    await confirmRefresh(first);
    await expect.poll(async () => (await readRefreshEvidence(first)).dialogPhase, { timeout: 5_000 })
      .toBe('running');
    const running = await readRefreshEvidence(first);
    expect(running.confirmDisabled, 'the running dialog offers no second start').toBe(true);
    expect(running.footerState).toBe('running');
    expect(running.footerDisabled).toBe(true);
    await expect(first.locator(SEL.dialogElapsed)).toBeVisible();
    await shot(first, '03-running');

    // 4. The second page presses Refresh at the same moment: the server must join
    //    the running job, not spawn a second CLI.
    await openRefreshDialog(second);
    await confirmRefresh(second);
    await expect.poll(async () => (await readRefreshEvidence(second)).dialogPhase, { timeout: 5_000 })
      .toBe('running');
    expect(counterCount(), 'two concurrent presses must produce ONE CLI invocation').toBe(1);

    // 5. A tab opened MID-RUN reads the shared status and offers no start door.
    const third = await newEvidencePage(context);
    await openPage(third, sessionId);
    await expect.poll(async () => (await readRefreshEvidence(third)).footerState, { timeout: 10_000 })
      .toBe('running');
    const midRun = await readRefreshEvidence(third);
    expect(midRun.footerDisabled, 'a tab opened mid-run must not offer a second start').toBe(true);
    expect(midRun.counter).toBe(1);
    await shot(third, '04-mid-run-tab');

    // 6. Success: the dialog closes, the footer's analysis time moves, the
    //    previously-unresolved name is found, and the drawing is fitted again.
    await expect.poll(async () => (await readRefreshEvidence(first)).generatedAt, { timeout: 30_000 })
      .not.toBe(OLD_GENERATED_AT);
    await expect(first.locator(SEL.dialog)).toHaveCount(0);
    await expect.poll(async () => (await readRefreshEvidence(first)).unresolved, { timeout: 20_000 })
      .toBe(0);
    await expect.poll(async () => (await readRefreshEvidence(first)).zoomMode, { timeout: 10_000 })
      .toBe('fit');
    const succeeded = await readRefreshEvidence(first);
    expect(succeeded.footerState).toBe('succeeded');
    expect(succeeded.counter).toBe(1);
    expect(succeeded.manifestHash).not.toBe(before.manifestHash);
    await shot(first, '05-succeeded');

    // 7. Failure: the reason and Retry appear, and the live analysis is untouched.
    writeControl('fail', 0);
    await openRefreshDialog(first);
    await confirmRefresh(first);
    await expect.poll(async () => (await readRefreshEvidence(first)).dialogPhase, { timeout: 20_000 })
      .toBe('failed');
    const failed = await readRefreshEvidence(first);
    expect(failed.dialogError).toContain('deliberate analysis failure');
    expect(failed.generatedAt, 'a failed run must not move the analysis time').toBe(succeeded.generatedAt);
    expect(failed.manifestHash, 'a failed run must leave the live manifest byte-for-byte').toBe(succeeded.manifestHash);
    expect(failed.counter).toBe(2);
    await expect(first.locator(SEL.dialogConfirm)).toBeEnabled();
    await expect(first.locator(SEL.dialogConfirm)).toHaveText('Retry');
    await shot(first, '06-failed-retry');

    writeControl('success', 0);
    await first.locator(SEL.dialogCancel).click();

    const elapsed = Date.now() - RUN_STARTED_AT;
    console.log(`[architecture-refresh] elapsed=${elapsed}ms`);
  } finally {
    writeControl('success', 0);
    setDefect('');
    await context.close();
  }
});

test('control arm: removing single-flight and staging turns the same readings red', async ({ browser }) => {
  const context = await openContext(browser, baseURL, token);
  try {
    const first = await newEvidencePage(context);
    const second = await newEvidencePage(context);
    await openPage(first, sessionId);
    await openPage(second, sessionId);

    // ── single-flight removed: two presses, two invocations ────────────────────
    setDefect('no-coalesce');
    writeControl('success', 2_000);
    resetCounter();
    await openRefreshDialog(first);
    await confirmRefresh(first);
    await openRefreshDialog(second);
    await confirmRefresh(second);
    await expect.poll(() => counterCount(), { timeout: 15_000 }).toBe(2);
    const noCoalesce = await readRefreshEvidence(first);
    expect(noCoalesce.counter, 'without single-flight the counter reads 2, so the main arm’s 1 is a reading').toBe(2);
    await shot(first, '07-control-no-coalesce');

    // Let both jobs finish before the next arm rewrites the settings.
    await expect.poll(async () => (await readRefreshEvidence(first)).footerState, { timeout: 30_000 })
      .not.toBe('running');

    // ── staging removed: a failed run mutates the live manifest ────────────────
    setDefect('no-preserve');
    writeControl('fail', 0);
    resetCounter();
    const beforeFailure = await readRefreshEvidence(first);
    await openRefreshDialog(first);
    await confirmRefresh(first);
    await expect.poll(async () => (await readRefreshEvidence(first)).dialogPhase, { timeout: 20_000 })
      .toBe('failed');
    const afterFailure = await readRefreshEvidence(first);
    expect(
      afterFailure.manifestHash,
      'without staging, a failed run changes the live manifest — the main arm reads the opposite',
    ).not.toBe(beforeFailure.manifestHash);
    await shot(first, '08-control-no-preserve');

    const elapsed = Date.now() - RUN_STARTED_AT;
    console.log(`[architecture-refresh] control elapsed=${elapsed}ms`);
  } finally {
    writeControl('success', 0);
    setDefect('');
    await context.close();
  }
});
