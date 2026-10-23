import fs from 'node:fs';
import path from 'node:path';

import { expect, request, test } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';

import { awaitClientMounted, warmClientStartup, type RequestFailure } from './support/client-startup-warmup';

/**
 * "Send the selection to the chat" from all four entry points, in a real browser.
 *
 * WHY THIS FILE EXISTS. The action existed only inside the collapsed selection
 * tray: a reader had to notice a small "N selected ▴" pill, open it and find
 * "Put in the input and switch to chat". The task adds the same action to the
 * inspector's Adjust row, the canvas context menu and the Text page, and makes
 * the pill name the action. Only a real browser can prove those controls exist
 * where the reader is standing, that clicking one actually lands text in the
 * composer and switches the workspace to Chat, and that the text names the
 * project the way the workspace labels it rather than by its UUID.
 *
 * THE FIXTURE. A three-entity `.archguard` tree written here, small on purpose:
 * at the whole-graph fit that three boxes produce, the class drawing keeps the
 * entity boxes visible on both viewports, so every path can click the SAME
 * entity by name. The session's own user text names the seed entity, which is
 * what the server's seed extractor resolves to build the graph.
 *
 * THE CONTROL ARM. The reading that matters is "the message carries the project
 * display name and no UUID-shaped id". The arm reproduces the shipped defect on
 * the SAME reading: the text of a real message with the display name replaced
 * by the project's real id — exactly what the old header put there — must flip
 * `hasUuid` to true and `hasProjectName` to false. A reading that cannot go red
 * on the defect would prove nothing.
 */

const RUN_STARTED_AT = Number(process.env.QUAY_E2E_RUN_STARTED_AT) || Date.now();

const VIEWPORT_PC = { width: 1440, height: 765 };
const VIEWPORT_PHONE = { width: 390, height: 844 };

const USERNAME = 'architecture-send-to-chat-e2e';
const PASSWORD = 'architecture-send-to-chat-e2e-pass';
const WORKSPACE_DIR = 'architecture-send-to-chat-workspace';

/** The entity every path acts on. */
const SEED_NAME = 'Alpha';
const SEED_ID = 'src/alpha/alpha.ts.Alpha';
/** The second entity, for the tray's two-entity leg: Alpha depends on Beta. */
const SECOND_NAME = 'Beta';
const SECOND_ID = 'src/alpha/beta.ts.Beta';
const THIRD_ID = 'src/beta/gamma.ts.Gamma';

/** The message must never carry an id of this shape (the header used to). */
const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const SEL = {
  panel: '[data-workspace-view="architecture"] [data-architecture-panel]',
  graphRoot: '[data-architecture-plantuml-graph]',
  host: '[data-architecture-plantuml]',
  node: '.uml-node[data-entity-id]',
  inspectorPut: '[data-architecture-inspector-put-in-chat]',
  contextPut: '[data-architecture-context-put-in-chat]',
  trayPill: '[data-architecture-tray-pill]',
  trayCompose: '[data-architecture-tray-compose]',
  textToggle: '[data-architecture-text-toggle]',
  textPut: '[data-architecture-text-put-in-chat]',
  composer: 'textarea[data-slot="prompt-input-textarea"]',
  chatTab: '[data-workspace-tab="chat"][aria-current="true"]',
} as const;

/* ── the fixture ─────────────────────────────────────────────────────────────────────────── */

/** One entity the fixture writes into both the index and the archive. */
type FixtureEntity = {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly kind: 'class' | 'interface';
  readonly parents: readonly string[];
};

const ENTITIES: readonly FixtureEntity[] = [
  { id: SEED_ID, name: 'Alpha', file: 'src/alpha/alpha.ts', kind: 'class', parents: [] },
  { id: SECOND_ID, name: 'Beta', file: 'src/alpha/beta.ts', kind: 'class', parents: [SEED_ID] },
  { id: THIRD_ID, name: 'Gamma', file: 'src/beta/gamma.ts', kind: 'interface', parents: [SECOND_ID] },
];

const SCOPE_KEY = 'scope-src';
const ARCH_JSON_HASH = 'b7c1f0d4b8e29365f0d4b8e29365a7c1f0d4b8e29365a7c1f0d4b8e29365a7c2';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Write the three-entity analysis tree the server reads.
 *
 * The shape is the one ArchGuard writes (and that
 * `e2e/support/architectureFixture.ts` reproduces for the geometry criteria):
 * `manifest.json`, the scope's `arch-index.json` with the adjacency maps, and
 * the sibling `arch.json` that gives each entity its kind.
 */
function writeFixture(workspaceDir: string): void {
  const srcDir = path.join(workspaceDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  const generatedAt = new Date().toISOString();
  const fileToIds: Record<string, string[]> = {};
  const nameToIds: Record<string, string[]> = {};
  const idToFile: Record<string, string> = {};
  const idToName: Record<string, string> = {};
  const dependencies: Record<string, string[]> = {};
  const dependents: Record<string, string[]> = {};
  for (const entity of ENTITIES) {
    (fileToIds[entity.file] ??= []).push(entity.id);
    (nameToIds[entity.name] ??= []).push(entity.id);
    idToFile[entity.id] = entity.file;
    idToName[entity.id] = entity.name;
    dependencies[entity.id] ??= [];
    dependents[entity.id] ??= [];
  }
  for (const entity of ENTITIES) {
    for (const parent of entity.parents) {
      dependencies[parent].push(entity.id);
      dependents[entity.id].push(parent);
    }
  }

  writeJson(path.join(workspaceDir, '.archguard', 'query', 'manifest.json'), {
    version: '1.0',
    generatedAt,
    globalScopeKey: SCOPE_KEY,
    scopes: [{ key: SCOPE_KEY, label: 'src (typescript)', language: 'typescript', sources: [srcDir] }],
  });
  writeJson(path.join(workspaceDir, '.archguard', 'query', SCOPE_KEY, 'arch-index.json'), {
    version: '1.0',
    language: 'typescript',
    archJsonHash: ARCH_JSON_HASH,
    generatedAt,
    fileToIds,
    nameToIds,
    idToFile,
    idToName,
    dependencies,
    dependents,
  });
  writeJson(path.join(workspaceDir, '.archguard', 'query', SCOPE_KEY, 'arch.json'), {
    version: '1.0',
    language: 'typescript',
    entities: ENTITIES.map((entity) => ({
      id: entity.id,
      name: entity.name,
      type: entity.kind,
      isAbstract: false,
      members:
        entity.kind === 'interface'
          ? [{ name: 'id', type: 'property', visibility: 'public', fieldType: 'string' }]
          : [
            { name: 'constructor', type: 'constructor', visibility: 'public', parameters: [] },
            { name: 'run', type: 'method', visibility: 'public', parameters: [], returnType: 'void' },
          ],
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

/** Arm the session whose user text seeds the three entities. */
async function armScenario(api: APIRequestContext, projectPath: string): Promise<string> {
  const scenario = {
    version: 1,
    dialect: 'claude',
    home: 'gate',
    transcript: { mode: 'per-row-jsonl' },
    seed: {
      title: 'Architecture send to chat',
      userText: `Please review \`${SEED_NAME}\` and \`${SECOND_NAME}\` before the refactor.`,
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

/** The project row the workspace lists this fixture under (display name + opaque id). */
async function readProject(
  api: APIRequestContext,
  workspace: string,
): Promise<{ projectId: string; displayName: string }> {
  const response = await api.get('/api/projects');
  const body = await response.json().catch(() => null);
  const projects: unknown = Array.isArray(body) ? body : (body as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(projects)) throw new Error(`/api/projects returned ${JSON.stringify(body).slice(0, 300)}`);
  const project = projects.find((candidate: { path?: string; fullPath?: string }) =>
    candidate.path === workspace || candidate.fullPath === workspace);
  if (project === undefined) throw new Error(`no project row for ${workspace}`);
  return {
    projectId: String((project as { projectId: string }).projectId),
    displayName: String((project as { displayName: string }).displayName),
  };
}

/* ── page setup ─────────────────────────────────────────────────────────────────────────── */

const startupEvidence: {
  pageErrors: string[];
  consoleErrors: string[];
  requestFailures: RequestFailure[];
  warmup: null;
} = { pageErrors: [], consoleErrors: [], requestFailures: [], warmup: null };

let warmClientPromise: Promise<unknown> | null = null;

async function openSignedInPage(
  browser: Browser,
  baseURL: string,
  token: string,
  form: { viewport: { width: number; height: number }; touch: boolean },
): Promise<{ context: BrowserContext; page: Page }> {
  const dataDir = process.env.QUAY_E2E_DATA_DIR;
  if (!dataDir) throw new Error('playwright.config.ts must publish QUAY_E2E_DATA_DIR');
  warmClientPromise ??= warmClientStartup(baseURL, dataDir);

  const context = await browser.newContext({
    baseURL,
    viewport: form.viewport,
    hasTouch: form.touch,
    isMobile: form.touch,
  });
  await context.addInitScript(
    ({ authKey, authToken, language }: { authKey: string; authToken: string; language: string }) => {
      window.localStorage.setItem(authKey, authToken);
      window.localStorage.setItem('userLanguage', language);
    },
    { authKey: 'auth-token', authToken: token, language: 'en' },
  );
  const page = await context.newPage();
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
  return { context, page };
}

const ARCHITECTURE_TAB_LANDING =
  '[role="tab"][data-workspace-tab="architecture"], [aria-haspopup="dialog"][data-workspace-tab]';

async function settle(page: Page, ms = 300): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await page.waitForTimeout(ms);
}

/** Open the architecture tab (desktop pill, or the phone picker). */
async function enterArchitecture(page: Page): Promise<void> {
  const desktopTab = page.locator('[role="tab"][data-workspace-tab="architecture"]');
  if ((await desktopTab.count()) > 0 && (await desktopTab.first().isVisible())) {
    await desktopTab.first().click();
  } else {
    await page.locator('[aria-haspopup="dialog"][data-workspace-tab]').first().click();
    await page.locator('[role="dialog"] [data-workspace-tab="architecture"]').first().click();
  }
  await expect(page.locator(SEL.panel), 'the architecture tab must open for the fixture project').toBeVisible({
    timeout: 30_000,
  });
  await page.waitForFunction(
    (sel) => {
      const root = document.querySelector(sel.graphRoot);
      const host = document.querySelector(sel.host);
      return Number(root?.getAttribute('data-architecture-visible-nodes') ?? '0') > 0
        && (host?.querySelectorAll(sel.node).length ?? 0) > 0;
    },
    SEL,
    { timeout: 40_000 },
  );
  await settle(page, 500);
}

/**
 * Make sure the drawn entity boxes are the ones on screen.
 *
 * The class graph opens on its semantic hierarchy; on a three-entity drawing
 * the whole-graph fit is large enough that the boxes are drawn as names. The
 * explosion control is pressed only where the tier exposes a different view, so
 * this stays a statement about the drawing rather than a preference.
 */
/**
 * The drawn box for one entity, by the name its id ends with.
 *
 * The server may prefix the fixture's ids with the scope key (`scope-src/…`),
 * so the criterion reads the drawing the way a reader does — by the label —
 * instead of restating an id shape the payload owns.
 */
function entityBox(page: Page, name: string): ReturnType<Page['locator']> {
  return page.locator(`.uml-node[data-entity-id$=".${name}"]`).first();
}

async function showEntityBoxes(page: Page): Promise<void> {
  const node = entityBox(page, SEED_NAME);
  const visible = async (): Promise<boolean> => (await node.count()) > 0 && (await node.isVisible());
  // A three-entity drawing fits at the semantic tier that draws names, so this
  // loop normally does nothing. If a tier folded the boxes into package counts
  // anyway, zooming in is the reader's own way out of it — never a state the
  // spec asserts into existence.
  for (let attempt = 0; attempt < 8 && !(await visible()); attempt += 1) {
    const zoomIn = page.locator('[data-architecture-zoom-in]');
    if ((await zoomIn.count()) === 0) break;
    await zoomIn.first().click();
    await page.waitForTimeout(180);
  }
  await expect(node, 'the selected entity must be a drawn box').toBeVisible({ timeout: 20_000 });
}

/* ── the message reading ────────────────────────────────────────────────────────────────── */

type MessageReading = {
  readonly length: number;
  readonly hasProjectName: boolean;
  readonly hasEntity: boolean;
  readonly hasSecondEntity: boolean;
  readonly hasUuid: boolean;
  readonly hasRelationLine: boolean;
};

/** The ONE reading every arm (and the control arm) goes through. */
function analyzeMessage(text: string, projectName: string, entityName: string): MessageReading {
  return {
    length: text.length,
    hasProjectName: projectName !== '' && text.includes(projectName),
    hasEntity: text.includes(entityName),
    hasSecondEntity: text.includes(SECOND_NAME),
    hasUuid: UUID_SHAPE.test(text),
    hasRelationLine: new RegExp(`${SEED_NAME} (→|←) ${SECOND_NAME} \\(dependency\\)`).test(text),
  };
}

/**
 * Optional browser evidence: when `ARCHITECTURE_SEND_SHOTS_DIR` is set, each
 * door's state is captured there. Off by default — the criterion's evidence is
 * its readings, and a suite run should not litter the tree.
 */
const SHOTS_DIR = process.env.ARCHITECTURE_SEND_SHOTS_DIR ?? '';

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS_DIR === '') return;
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
}

/** Read the composer's value once the action has landed text in it. */
async function readComposedMessage(page: Page): Promise<string> {
  const composer = page.locator(SEL.composer);
  await expect(composer, 'the action focuses the chat composer').toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => (await composer.inputValue()).length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  return composer.inputValue();
}

/** Empty the composer, returning the session to its initial state. */
async function clearDraft(page: Page): Promise<void> {
  const composer = page.locator(SEL.composer);
  await composer.fill('');
  await expect.poll(async () => composer.inputValue(), { timeout: 10_000 }).toBe('');
}

/**
 * After an action: the workspace is on Chat, the composer holds a message, and
 * that message names the project and the entity without an opaque id.
 */
async function assertMessageAndClear(
  page: Page,
  project: { displayName: string; projectId: string },
  arm: string,
): Promise<MessageReading> {
  await expect(page.locator(SEL.chatTab), `${arm}: the workspace switches to Chat`).toHaveCount(1, {
    timeout: 20_000,
  });
  const text = await readComposedMessage(page);
  const reading = analyzeMessage(text, project.displayName, SEED_NAME);
  console.log(`[architecture-send-to-chat] ${arm} reading=${JSON.stringify(reading)} text=${JSON.stringify(text.slice(0, 400))}`);
  await shot(page, `${arm}.composer`);
  expect(reading.hasProjectName, `${arm}: the message names the project ${project.displayName}`).toBe(true);
  expect(reading.hasEntity, `${arm}: the message names ${SEED_NAME}`).toBe(true);
  expect(reading.hasUuid, `${arm}: the message carries no UUID-shaped id`).toBe(false);
  // Keep the raw text for the control arm's red leg.
  lastMessageText = text;
  await clearDraft(page);
  return reading;
}

/** A real message's own text, so the control arm can restate the defect on it. */
let lastMessageText = '';

/* ── the run ───────────────────────────────────────────────────────────────────────────── */

let baseURL = '';
let token = '';
let sessionId = '';
let workspace = '';
let project: { projectId: string; displayName: string } | null = null;

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

  const bootstrap = await request.newContext({ baseURL });
  token = await createAccount(bootstrap);
  await bootstrap.dispose();

  const api = await request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  sessionId = await armScenario(api, workspace);
  project = await readProject(api, workspace);
  await api.dispose();

  console.log(`[architecture-send-to-chat] workspace=${workspace}`);
  console.log(`[architecture-send-to-chat] project=${JSON.stringify(project)}`);
  console.log(`[architecture-send-to-chat] session=${sessionId}`);
});

/** The four doors, each from a freshly entered architecture tab. */
async function walkFourDoors(
  page: Page,
  form: { label: string },
): Promise<void> {
  if (project === null) throw new Error('project row missing');

  // 1. The inspector's Adjust row.
  await page.goto(`/session/${sessionId}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await awaitClientMounted(page, ARCHITECTURE_TAB_LANDING, 25_000, startupEvidence);
  await enterArchitecture(page);
  await showEntityBoxes(page);
  await entityBox(page, SEED_NAME).click();
  const inspectorButton = page.locator(SEL.inspectorPut);
  await expect(inspectorButton, `${form.label}: the inspector offers the tray action`).toBeVisible({
    timeout: 15_000,
  });
  await settle(page, 400);
  await inspectorButton.first().scrollIntoViewIfNeeded();
  await shot(page, `${form.label}.inspector-open`);
  await inspectorButton.first().click();
  await assertMessageAndClear(page, project, `${form.label}.inspector`);

  // 2. The canvas context menu (a right click: the browser's own menu gesture).
  await enterArchitecture(page);
  await showEntityBoxes(page);
  await entityBox(page, SEED_NAME).click({ button: 'right' });
  const contextItem = page.locator(SEL.contextPut);
  await expect(contextItem, `${form.label}: the context menu offers the action`).toBeVisible({ timeout: 10_000 });
  await contextItem.first().scrollIntoViewIfNeeded();
  await shot(page, `${form.label}.context-menu-open`);
  await contextItem.first().click();
  await assertMessageAndClear(page, project, `${form.label}.context-menu`);

  // 3. The floating bar's expanded tray, with TWO entities so the message also
  //    carries the relation between them.
  await enterArchitecture(page);
  await showEntityBoxes(page);
  await entityBox(page, SEED_NAME).click();
  await entityBox(page, SECOND_NAME).click({ modifiers: ['Shift'] });
  const pill = page.locator(SEL.trayPill);
  await expect(pill, `${form.label}: the pill names the action`).toContainText(/Send to chat/, { timeout: 10_000 });
  await pill.first().click();
  await expect(page.locator(SEL.trayCompose), `${form.label}: the expanded tray carries the action`).toBeVisible({
    timeout: 10_000,
  });
  await settle(page, 250);
  await page.locator(SEL.trayCompose).first().scrollIntoViewIfNeeded();
  await shot(page, `${form.label}.tray-open`);
  await page.locator(SEL.trayCompose).first().click();
  const trayText = await readComposedMessage(page);
  const trayReading = analyzeMessage(trayText, project.displayName, SEED_NAME);
  console.log(`[architecture-send-to-chat] ${form.label}.tray reading=${JSON.stringify(trayReading)} text=${JSON.stringify(trayText.slice(0, 600))}`);
  expect(trayReading.hasProjectName, `${form.label}: the tray message names the project`).toBe(true);
  expect(trayReading.hasEntity, `${form.label}: the tray message names ${SEED_NAME}`).toBe(true);
  expect(trayReading.hasSecondEntity, `${form.label}: the tray message names ${SECOND_NAME}`).toBe(true);
  expect(trayReading.hasRelationLine, `${form.label}: the two selected entities' relation is stated`).toBe(true);
  expect(trayReading.hasUuid, `${form.label}: the tray message carries no UUID`).toBe(false);
  lastMessageText = trayText;
  await shot(page, `${form.label}.tray.composer`);
  await clearDraft(page);

  // 4. The Text page's own action (the current scope's context text).
  await enterArchitecture(page);
  await page.locator(SEL.textToggle).first().click();
  await expect(page.locator(SEL.textPut), `${form.label}: the Text page offers the action`).toBeVisible({
    timeout: 15_000,
  });
  await settle(page, 400);
  await page.locator(SEL.textPut).first().scrollIntoViewIfNeeded();
  await shot(page, `${form.label}.text-panel-open`);
  await page.locator(SEL.textPut).first().click();
  await assertMessageAndClear(page, project, `${form.label}.text-panel`);
}

test('four doors send the selection to the chat on the PC viewport (1440x765)', async ({ browser }) => {
  const { context, page } = await openSignedInPage(browser, baseURL, token, { viewport: VIEWPORT_PC, touch: false });
  try {
    await walkFourDoors(page, { label: 'pc' });

    // Control arm: the defect was "the header names the project by its id".
    // Restate it on the SAME real message and read it through the SAME function.
    if (project === null) throw new Error('project row missing');
    expect(project.projectId).toMatch(UUID_SHAPE);
    const healthy = analyzeMessage(lastMessageText, project.displayName, SEED_NAME);
    const defectiveText = lastMessageText.split(project.displayName).join(project.projectId);
    const defective = analyzeMessage(defectiveText, project.displayName, SEED_NAME);
    console.log(`[architecture-send-to-chat] control healthy=${JSON.stringify(healthy)} defective=${JSON.stringify(defective)}`);
    expect(healthy.hasUuid, 'the shipped reading is green on the real message').toBe(false);
    expect(defective.hasUuid, 'restoring the project id in the header turns the no-UUID reading red').toBe(true);
    expect(defective.hasProjectName, 'and the display-name reading goes red with it').toBe(false);

    const elapsed = Date.now() - RUN_STARTED_AT;
    console.log(`[architecture-send-to-chat] pc elapsed=${elapsed}ms`);
  } finally {
    await context.close();
  }
});

test('four doors send the selection to the chat on the phone viewport (390x844)', async ({ browser }) => {
  const { context, page } = await openSignedInPage(browser, baseURL, token, { viewport: VIEWPORT_PHONE, touch: true });
  try {
    await walkFourDoors(page, { label: 'phone' });
    const elapsed = Date.now() - RUN_STARTED_AT;
    console.log(`[architecture-send-to-chat] phone elapsed=${elapsed}ms`);
  } finally {
    await context.close();
  }
});
