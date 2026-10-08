/**
 * AC-194 — the activity dock shows background work, on a real browser against a real server.
 *
 * What this file is *for*. A debug-agent scenario's clock writes task-lifecycle rows and a `CronCreate`
 * plan; the product's own run loop reduces them (the Task table, AC-191, and the Schedule table,
 * AC-192); the activity protocol (AC-193) carries the session's whole snapshot to a subscribed
 * browser. This file reads the four surfaces that fact lands on, each as a *reading that could have
 * gone the other way*:
 *
 *   - the dock's summary counters (task count, plan count) equal the snapshot's *while the tasks are
 *     live*;
 *   - the expanded panel lists every **live** task (description, state, elapsed, last action) and
 *     every plan (expression, countdown, prompt), and a task that settles **leaves the panel** — the
 *     dock reports current activity, so a finished task does not linger as an inert row;
 *   - the live reading changes **without a navigation** when the clock settles a task, and *survives
 *     a reload* restored from the server's snapshot;
 *   - the transcript's Agent and Bash card headers read the Task entity by `tool_use` id, so their
 *     state moves when the task does — not from whether a result row happens to be folded in. This is
 *     also the control for the row above: the task table keeps the terminal row (the cards read
 *     `completed`), so the panel's empty task section is a *filter*, not a lost task;
 *   - a plan row renders no cancel control (selector count zero, by construction).
 *
 * Why the session is opened after the clock. The control plane's clock opens a *per-run* run whose writer
 * has no socket attached at open time (`openUnattendedRun` starts with `connection: null`), so a page that
 * subscribed *before* the walk does not receive its transcript frames live. Opening the session after the
 * clock has started makes the subscribe land while the run is in flight, so the socket attaches and the
 * client replays/fetches the rows written so far — which is how the cards and their running task states
 * come on screen. Everything after that (the terminal upserts) arrives live, which is exactly the reading
 * AC-194's "changes without a reload" pins. The measured window opens after the session is open and sees
 * no navigation.
 */

import path from 'node:path';

import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';

const PANE = '.chat-messages-pane';
const DOCK_TOGGLE = '[data-activity-dock-toggle]';
const PANEL = '[data-activity-dock-panel]';
const TASK_ROW = '[data-activity-task-row]';
const SCHEDULE_ROW = '[data-activity-schedule-row]';
const CARD_TASK_STATE = '[data-card-task-state]';
const CARD_FOLDED_STATUS = '[data-card-folded-status]';

const USERNAME = 'activity-dock-background-e2e';
const PASSWORD = 'activity-dock-background-e2e-pass';
const TITLE = 'Activity dock background — task and plan arm';
const SEED_USER_TEXT = 'seeded user turn for the activity-dock background criterion';

const TASK_AGENT = 'task-agent';
const TASK_SHELL = 'task-shell';

/**
 * The background-work walk.
 *
 * A `Task` call and a `Bash` call become the two transcript cards, each separated from its neighbours by an
 * assistant text row so it renders inline as a singleton rather than being folded into a collapsed work
 * segment; each is followed by a `task-started` that joins the task to the call's `tool_use` id (minted by
 * the engine, never named here). A `CronCreate` call/result pair becomes the plan. The two tasks start
 * early and settle late (7s / 7.5s) so there is a wide window in which the panel and the cards read
 * `running` before the terminal frames arrive — the window the "changes without a reload" arm reads
 * across. The walk writes eleven rows.
 */
const SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: TITLE, userText: SEED_USER_TEXT, lifecycleMode: 'per-run' },
  steps: [
    { at: 0, op: 'tool-call', name: 'Task' },
    { at: 300, op: 'task-started', taskId: TASK_AGENT, taskType: 'local_agent', description: 'Explore the repo' },
    { at: 600, op: 'task-progress', taskId: TASK_AGENT, description: 'reading files' },
    { at: 800, op: 'row', role: 'assistant', text: 'Started the exploration agent.' },
    { at: 1_000, op: 'tool-call', name: 'Bash' },
    { at: 1_200, op: 'task-started', taskId: TASK_SHELL, taskType: 'local_bash', description: 'Long build' },
    { at: 1_400, op: 'row', role: 'assistant', text: 'And a background build.' },
    { at: 1_600, op: 'schedule-plan', expression: '*/2 * * * *', human: 'Every 2 minutes', prompt: 'check the queue' },
    { at: 2_000, op: 'wait' },
    { at: 3_600, op: 'task-updated', taskId: TASK_AGENT, status: 'completed' },
    { at: 3_800, op: 'task-notification', taskId: TASK_SHELL, status: 'completed', summary: 'build done' },
    { at: 4_400, op: 'wait' },
  ],
  expect: { rows: { delta: 11 }, content: { mustContain: [SEED_USER_TEXT] } },
};

// ---------------------------------------------------------------------------------------------
// The wire, read by this file rather than through the page.
// ---------------------------------------------------------------------------------------------

type ActivitySnapshot = {
  sessionId?: string;
  rev?: number;
  tasks?: Array<{ taskId: string; state: string; description?: string }>;
  schedules?: Array<{ scheduleId: string; spec?: string }>;
};

type HostsSnapshot = { hosts: Array<{ bindings: Array<{ appSessionId: string; leases?: unknown[] }> }> };

/** `GET /api/session-hosts`, as this file reads it — the poll source the panel must NOT be drawn from. */
async function readHosts(api: APIRequestContext): Promise<HostsSnapshot> {
  const response = await api.get('/api/session-hosts');
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`GET /api/session-hosts answered ${response.status()}: ${JSON.stringify(body)}`);
  }
  return { hosts: body?.data?.hosts ?? [] };
}

/** `GET /api/sessions/:id/activity` — the snapshot the panel and the dock are drawn from. */
async function readActivitySnapshot(api: APIRequestContext, sessionId: string): Promise<{
  status: number;
  snapshot: ActivitySnapshot | null;
}> {
  const response = await api.get(`/api/sessions/${encodeURIComponent(sessionId)}/activity`);
  const body = await response.json().catch(() => null);
  return { status: response.status(), snapshot: (body as ActivitySnapshot | null) ?? null };
}

// ---------------------------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------------------------

const projectRow = (page: Page, workspaceName: string): Locator =>
  page.getByRole('button', { name: new RegExp(`^${workspaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first();

const sessionRow = (page: Page, sessionId: string): Locator =>
  page.locator(`a[href="/session/${sessionId}"]`).first();

async function explain(page: Page, what: string): Promise<never> {
  const body = await page.locator('body').innerText().catch(() => '<unreadable>');
  throw new Error(`${what}; the page held:\n${body.slice(0, 2_000)}`);
}

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

/** Creates (or signs in) the fixture account and returns its bearer token. */
async function createAccount(api: APIRequestContext): Promise<string> {
  const register = await api.post('/api/auth/register', { data: { username: USERNAME, password: PASSWORD } });
  const registered = await register.json().catch(() => null);
  if (typeof registered?.token === 'string') {
    await api.post('/api/user/complete-onboarding', { headers: { Authorization: `Bearer ${registered.token}` } });
    return registered.token;
  }
  const login = await api.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } });
  const loggedIn = await login.json().catch(() => null);
  if (typeof loggedIn?.token !== 'string') {
    throw new Error(`could not create or sign in as ${USERNAME}: ${register.status()} ${JSON.stringify(registered)}`);
  }
  return loggedIn.token;
}

/** Arms one scenario and returns the session id the rest of this file addresses it by. */
async function armScenario(api: APIRequestContext, projectPath: string, scenario: unknown): Promise<string> {
  const response = await api.post('/api/debug-agent/scenarios', { data: { projectPath, scenario } });
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`arming failed (${response.status()}): ${JSON.stringify(body)}`);
  }
  const sessionId = body?.data?.sessionId;
  if (typeof sessionId !== 'string') {
    throw new Error(`arming returned no sessionId: ${JSON.stringify(body)}`);
  }
  return sessionId;
}

/** The panel's readings, straight off the DOM. */
async function readPanel(page: Page): Promise<{
  tasks: Array<{ id: string | null; state: string | null; description: string; elapsed: string; lastAction: string }>;
  plans: Array<{ id: string | null; expression: string; countdown: string; prompt: string }>;
}> {
  const tasks = await page.locator(TASK_ROW).evaluateAll((rows) =>
    rows.map((row) => ({
      id: row.getAttribute('data-task-id'),
      state: row.getAttribute('data-task-state'),
      description: row.querySelector('[data-task-description]')?.textContent?.trim() ?? '',
      elapsed: row.querySelector('[data-task-elapsed]')?.textContent?.trim() ?? '',
      lastAction: row.querySelector('[data-task-last-action]')?.textContent?.trim() ?? '',
    })),
  );
  const plans = await page.locator(SCHEDULE_ROW).evaluateAll((rows) =>
    rows.map((row) => ({
      id: row.getAttribute('data-schedule-id'),
      expression: row.querySelector('[data-schedule-expression]')?.textContent?.trim() ?? '',
      countdown: row.querySelector('[data-schedule-countdown]')?.textContent?.trim() ?? '',
      prompt: row.querySelector('[data-schedule-prompt]')?.textContent?.trim() ?? '',
    })),
  );
  return { tasks, plans };
}

/** The cards' task-driven states, one per card that reads a Task entity. */
async function readCardTaskStates(page: Page): Promise<string[]> {
  return (await page.locator(CARD_TASK_STATE).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-card-task-state') ?? ''),
  )).filter((value) => value.length > 0).sort();
}

/** The cards' transcript-own (folded-row) states — the reading the false form would use instead. */
async function readCardFoldedStates(page: Page): Promise<string[]> {
  return (await page.locator(CARD_FOLDED_STATUS).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-card-folded-status') ?? ''),
  )).sort();
}

test.describe.configure({ mode: 'serial' });

test.describe('activity dock background', () => {
  let page: Page;
  let api: APIRequestContext;
  let workspace = '';
  let sessionId = '';
  let navigations = 0;

  test.beforeAll(async ({ browser }) => {
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');
    const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
    if (!fixtureHome) throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME');
    if (!process.env.QUAY_E2E_RUN_STARTED_AT) throw new Error('playwright.config.ts must publish QUAY_E2E_RUN_STARTED_AT');

    workspace = path.join(fixtureHome, 'activity-dock-background-workspace');
    const workspaceName = path.basename(workspace);

    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();
    api = await request.newContext({ baseURL: clientUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });

    sessionId = await armScenario(api, workspace, SCENARIO);

    // Before `browser.newContext()`, and therefore before any page of this run exists, so this run's own
    // optimizer commit happens outside the criterion's first navigation — see `warmClientStartup`. This
    // describe's first navigation is the one thing the sibling AC-199 startup healing never covered,
    // because `-g "AC-194"` runs only this describe and so the warm-up its sibling performs had never
    // been in this case's path.
    console.log(`[e2e] client warm-up: ${await warmClientStartup(clientUrl)}ms`);

    const context = await browser.newContext({ baseURL: clientUrl });
    await context.addInitScript(
      ({ key, value }: { key: string; value: string }) => {
        window.localStorage.setItem(key, value);
        window.localStorage.setItem('userLanguage', 'en');
      },
      { key: 'auth-token', value: token },
    );
    page = await context.newPage();
    page.on('pageerror', (error) => console.log(`[e2e] pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') console.log(`[e2e] console.error: ${message.text()}`);
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations += 1;
    });

    // The sidebar is waited for with a bounded probe rather than a fixed 25s wait plus a reload fallback.
    // That fallback fired whenever a cold Vite optimize replaced this run's first document whole, and its
    // 25s probe then ran its *full* length on the document that no longer rendered — a fixed cost that
    // grows with host load and, for the AC-194 criterion, was the difference between a pass and the 47757ms
    // / 42771ms reds this change closes. The warm-up above has already committed this run's pre-bundle, so
    // the document the probe is now asked about is one that stays; the probe is bounded (`STARTUP_PROBE_MS`)
    // and the whole preamble is bounded (`STARTUP_PROBE_DEADLINE_MS`), so a page that is genuinely broken
    // ends here naming the workspace instead of at a ceiling that names neither url nor status.
    //
    // The session row is revealed but *not* opened here: the test opens it after the clock starts, so the
    // subscribe that mounts the session view lands while the run is already in flight and attaches the live
    // stream.
    await page.goto('/');
    console.log(`[e2e] sidebar ready: ${await awaitWorkspaceInSidebar(page, workspaceName)}ms`);
    await revealSession(page, workspaceName, sessionId);
  });

  test.afterAll(async () => {
    await page?.close();
    await api?.dispose();
  });

  test('AC-194 background work reaches the dock, changes without a reload, and restores from a snapshot', async () => {
    const runStartedAt = Number(process.env.QUAY_E2E_RUN_STARTED_AT);

    // Fire the walk without awaiting it: the readings below happen while it is in flight. The response is
    // awaited at the very end, for the one fact only it carries — that the walk completed.
    const clock = api
      .post('/api/debug-agent/clock', { data: { sessionId } })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as { success?: boolean; error?: unknown } | null;
        console.log(`clock.status=${response.status()} clock.body=${JSON.stringify(body).slice(0, 400)}`);
        return { ok: response.ok(), status: response.status(), body };
      })
      .catch((error: unknown) => ({ ok: false, status: -1, body: { failed: String(error) } }));

    // Let the run open and write its first rows, then open the session: the subscribe that mounts the
    // view lands while the run is in flight, so the socket attaches and the client replays/fetches the
    // rows written so far. This is before the measured window; from here on the panel and the cards must
    // move with the frames alone.
    await page.waitForTimeout(500);
    await sessionRow(page, sessionId).click();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });

    // The transcript renders each card inline: an assistant text row separates the calls, so no two work
    // rows are adjacent and each is a singleton rather than a folded work segment.
    const preSnapshot = await readActivitySnapshot(api, sessionId);
    console.log(`diag.snapshot.status=${preSnapshot.status} snapshot.tasks=${preSnapshot.snapshot?.tasks?.length} snapshot.plans=${preSnapshot.snapshot?.schedules?.length}`);
    console.log(`diag.dockToggleCount=${await page.locator(DOCK_TOGGLE).count()} diag.cardCount=${await page.locator(CARD_TASK_STATE).count()} diag.foldedCount=${await page.locator(CARD_FOLDED_STATUS).count()}`);

    // The cards and the plan come on screen as the run streams; the dock's counter makes the panel
    // reachable.
    await expect(page.locator(DOCK_TOGGLE)).toBeVisible({ timeout: 25_000 });
    await page.locator(DOCK_TOGGLE).click();
    await expect(page.locator(PANEL)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(TASK_ROW)).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator(SCHEDULE_ROW)).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator(CARD_TASK_STATE)).toHaveCount(2, { timeout: 8_000 });

    const running = await readPanel(page);
    const runningCards = await readCardTaskStates(page);
    console.log(`running.tasks=${JSON.stringify(running.tasks)}`);
    console.log(`running.plans=${JSON.stringify(running.plans)}`);
    console.log(`running.cardTaskStates=${JSON.stringify(runningCards)} at +${Date.now() - runStartedAt}ms`);
    expect(running.tasks.map((task) => task.state).sort()).toEqual(['running', 'running']);
    expect(runningCards, 'the cards must read the running task states before the terminal frames').toEqual(['running', 'running']);

    // --- AC3: the dock summary counters agree with the snapshot --------------------------------
    const dockTaskCount = await page.locator('[data-activity-task-count]').getAttribute('data-activity-task-count');
    const dockScheduleCount = await page.locator('[data-activity-schedule-count]').getAttribute('data-activity-schedule-count');
    const { status: snapStatus, snapshot } = await readActivitySnapshot(api, sessionId);
    console.log(`dock.counts=${dockTaskCount}/${dockScheduleCount} snapshot.status=${snapStatus} snapshot.tasks=${snapshot?.tasks?.length} snapshot.plans=${snapshot?.schedules?.length}`);
    expect(snapStatus).toBe(200);
    expect(Number(dockTaskCount)).toBe(snapshot?.tasks?.length);
    expect(Number(dockScheduleCount)).toBe(snapshot?.schedules?.length);
    expect(snapshot?.tasks?.length).toBe(2);
    expect(snapshot?.schedules?.length).toBe(1);

    // --- AC4: four readings per task row -------------------------------------------------------
    for (const task of running.tasks) {
      expect(task.description.length, 'a task row must carry its description').toBeGreaterThan(0);
      expect(task.elapsed.length, 'a task row must carry an elapsed reading').toBeGreaterThan(0);
      expect(task.lastAction.length, 'a task row must carry a last-action reading').toBeGreaterThan(0);
    }

    // --- AC5: three readings per plan row ------------------------------------------------------
    const plan = running.plans[0];
    expect(plan.expression, 'the plan row must show the expression').toContain('Every');
    expect(plan.countdown, 'the plan row must show a next-fire countdown').toMatch(/^\d/);
    expect(plan.prompt, 'the plan row must show the prompt').toBe('check the queue');

    // --- AC9: a plan has no control at all -----------------------------------------------------
    const cancelControls = await page.locator('[data-schedule-cancel]').count();
    console.log(`plan.cancelControls=${cancelControls}`);
    expect(cancelControls, 'a plan row must render no cancel control').toBe(0);

    // --- AC6: the state changes without a reload -----------------------------------------------
    // The measured window opens here: no navigation may happen between now and the terminal reading.
    navigations = 0;
    // The clock settles both tasks (7s / 7.5s), and the dock reports *current* activity: the live
    // task rows are what disappear, which is the transition this wait is for. The panel itself
    // stays (the plan is still held), so a count of zero here is the task section leaving, not a
    // panel that failed to draw.
    await expect(page.locator(TASK_ROW)).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator(SCHEDULE_ROW)).toHaveCount(1, { timeout: 8_000 });
    const settled = await readPanel(page);
    await expect(page.locator(CARD_TASK_STATE)).toHaveCount(2, { timeout: 8_000 });
    const settledCards = await readCardTaskStates(page);
    console.log(`settled.tasks=${JSON.stringify(settled.tasks.map((task) => task.state))} settled.plans=${settled.plans.length} settled.cards=${JSON.stringify(settledCards)}`);
    expect(
      settled.tasks,
      'a settled task leaves the panel; the dock is a current-activity reading, not a history',
    ).toEqual([]);
    expect(navigations, 'the state must change without a navigation').toBe(0);

    // --- AC8: the card header reads the Task entity, and moves with it ---------------------------
    // The folded-row reading is the negative control: for a task whose result row never arrived it is
    // still `running`, while the task-driven reading is terminal. A card that inferred state from the
    // folded row would read `running` here and fail the assertion above.
    const foldedStates = await readCardFoldedStates(page);
    console.log(`settled.cardTaskStates=${JSON.stringify(settledCards)} settled.cardFoldedStates=${JSON.stringify(foldedStates)}`);
    expect(settledCards, 'the card headers must have moved to the terminal task state').toEqual(['completed', 'completed']);
    expect(runningCards, 'the card headers must have been running before the terminal frames').not.toEqual(settledCards);
    expect(foldedStates.every((value) => value === 'running'), 'the folded-row reading must still be running').toBe(true);

    // --- AC7: a fresh load restores the panel from the snapshot ---------------------------------
    const beforeReload = await readPanel(page);
    await page.reload();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    // The restored dock must show the counts again (the snapshot path), so the panel is reachable.
    await expect(page.locator(DOCK_TOGGLE)).toBeVisible({ timeout: 25_000 });
    await page.locator(DOCK_TOGGLE).click();
    await expect(page.locator(PANEL)).toBeVisible({ timeout: 15_000 });
    // The restore is from the snapshot, and the snapshot still carries both (terminal) tasks — but
    // the panel lists live work only, so the restored panel has no task row and keeps the plan.
    await expect(page.locator(TASK_ROW)).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator(SCHEDULE_ROW)).toHaveCount(1, { timeout: 15_000 });
    const restored = await readPanel(page);
    console.log(`restored.tasks=${JSON.stringify(restored.tasks.map((task) => task.id))} restored.plans=${JSON.stringify(restored.plans.map((plan) => plan.id))}`);
    expect(restored.tasks.map((task) => task.id).sort()).toEqual(beforeReload.tasks.map((task) => task.id).sort());
    expect(restored.plans.map((plan) => plan.id)).toEqual(beforeReload.plans.map((plan) => plan.id));
    // The restore comes from the activity snapshot, not the session-hosts poll.
    const afterReloadSnapshot = await readActivitySnapshot(api, sessionId);
    expect(afterReloadSnapshot.status).toBe(200);
    expect(afterReloadSnapshot.snapshot?.tasks?.length).toBe(2);
    expect(afterReloadSnapshot.snapshot?.schedules?.length).toBe(1);

    // --- AC11(2): the panel is not drawn from the session-hosts poll ----------------------------
    // The poll source carries host leases, not tasks or plans — a panel driven by it could not show
    // these rows. Proven by reading the listing and showing it has no task rows while the panel does.
    const hosts = await readHosts(api);
    const listingLeases = hosts.hosts
      .flatMap((host) => host.bindings)
      .filter((binding) => binding.appSessionId === sessionId)
      .flatMap((binding) => binding.leases ?? []);
    console.log(`falseForm2.sessionHostsLeases=${listingLeases.length} falseForm2.panelRows=${restored.tasks.length + restored.plans.length}`);
    // The restored panel carries the one live row the snapshot holds (the plan). The two tasks are
    // in the snapshot too, but terminal, so they are not rows — and the count above (`TASK_ROW`
    // == 0) is what makes that a filter rather than a snapshot that lost its tasks.
    expect(restored.tasks.length + restored.plans.length, 'the panel is drawn from the snapshot and carries its live rows').toBe(1);
    expect(afterReloadSnapshot.snapshot?.tasks?.length, 'the snapshot itself still holds both terminal tasks').toBe(2);
    expect(listingLeases.length, 'the session-hosts poll carries no task/schedule rows').toBe(0);

    // --- The walk itself completed --------------------------------------------------------------
    const clockBody = await clock;
    expect(clockBody.ok, `the walk must complete: ${JSON.stringify(clockBody)}`).toBe(true);
    expect(clockBody.body?.success, `the walk must report success: ${JSON.stringify(clockBody.body)}`).toBe(true);

    // --- AC1: the wall clock ------------------------------------------------------------------
    const elapsedMs = Date.now() - runStartedAt;
    console.log(`AC-194 wall clock: ${elapsedMs}ms`);
    expect(elapsedMs, 'the criterion must complete within 40s').toBeLessThanOrEqual(40_000);
  });
});

// =============================================================================================
// AC-199 — the dock's controls, on the same real browser against the same real server.
// =============================================================================================

const CONTROL_TITLE = 'Activity dock controls — stop and background';
const CONTROL_SEED = 'seeded user turn for the activity-dock controls criterion';

const STOP_TARGET = 'task-stop-target';
const TERMINAL_TASK = 'task-terminal';
const NEVER_TASK = 'task-never';
const BG_TASK = 'task-bg';

/**
 * The barrier the click window ends at, and where the control events sit behind
 * it, in ms from the walk's start.
 *
 * These used to be a fixed 12s, chosen to outrun the click window on the hosts
 * this criterion was written on. That is a race rather than a reading: on a loaded
 * host the clicks take longer than the offset, the events fire first, and the run
 * fails the very assertions meant to prove the click was not optimistic. The
 * barrier replaces the race with a handshake — the walk is held at `RELEASE_AT`
 * until this spec's own reading window has closed and says so — so "the click did
 * not change the row; the event did" holds at any host speed. The offsets behind
 * it are only as far apart as they need to be to order the frames; already due
 * when the release lands, they fire back to back.
 */
const RELEASE_AT = 1_600;
const STOP_EVENT_AT = RELEASE_AT + 100;
const BG_STARTED_AT = RELEASE_AT + 200;
const BG_UPDATED_AT = RELEASE_AT + 300;

const FOREGROUND_ROW = '[data-foreground-tool-row]';
const TASK_STOP = '[data-task-stop]';
const BACKGROUND_TOOL = '[data-background-tool]';
const DISABLED_REASON = '[data-control-disabled-reason]';

/**
 * The control walk.
 *
 * Three tasks are in the table before the click window opens: `STOP_TARGET` and
 * `NEVER_TASK` run (so the panel lists two live rows, each with a stop control),
 * and `TERMINAL_TASK` is settled to `completed` (so the table holds a terminal
 * task the panel never lists — the reading that the list is the live set). A
 * `Bash` call with no paired result is left pending — the running foreground
 * tool the background control addresses. Both control *events* sit behind the
 * `await-release` barrier, so the whole click-and-read window happens before
 * either no matter how slow the host is, and the settle is attributable to the
 * event and not to the click. The barrier itself writes nothing, so the walk
 * still writes twelve rows.
 */
const CONTROL_SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: CONTROL_TITLE, userText: CONTROL_SEED, lifecycleMode: 'per-run' },
  steps: [
    { at: 0, op: 'tool-call', name: 'Task' },
    { at: 200, op: 'task-started', taskId: STOP_TARGET, taskType: 'local_agent', description: 'Agent still running' },
    { at: 400, op: 'task-started', taskId: TERMINAL_TASK, taskType: 'local_bash', description: 'Finished build' },
    { at: 600, op: 'task-notification', taskId: TERMINAL_TASK, status: 'completed', summary: 'build done' },
    { at: 700, op: 'task-started', taskId: NEVER_TASK, taskType: 'local_bash', description: 'Watcher stays up' },
    { at: 900, op: 'tool-result', text: 'agent finished' },
    { at: 1_100, op: 'row', role: 'assistant', text: 'Started the agent.' },
    { at: 1_300, op: 'tool-call', name: 'Bash' },
    { at: 1_500, op: 'row', role: 'assistant', text: 'And a long build in the foreground.' },
    // The click window ends here: the walk parks until this spec releases it, so
    // every event below fires after the readings that must precede it — never
    // before, at any host speed.
    { at: RELEASE_AT, op: 'await-release' },
    { at: STOP_EVENT_AT, op: 'task-notification', taskId: STOP_TARGET, status: 'stopped', summary: 'stopped from the dock' },
    { at: BG_STARTED_AT, op: 'task-started', taskId: BG_TASK, taskType: 'local_bash', description: 'Backgrounded build' },
    { at: BG_UPDATED_AT, op: 'task-updated', taskId: BG_TASK, status: 'running', isBackgrounded: true },
    { at: BG_UPDATED_AT + 300, op: 'wait' },
  ],
  expect: { rows: { delta: 12 }, content: { mustContain: [CONTROL_SEED] } },
};

/**
 * How long the sidebar's project row is given before a reload is tried, and the
 * whole bounded preamble that may contain such reloads.
 *
 * The probe used to be a single 25s wait. That is a fixed cost that scales with
 * the host, and it is the one this criterion was red on: a cold Vite dev server
 * answers the first navigation with a document it then replaces (`full-reload`)
 * as soon as its dependency optimizer commits, so the sidebar the wait is looking
 * for never renders on *that* document — and a loaded host makes the wait run its
 * full length before the declared fallback reload finally tries a document that
 * stays. Probing for a few seconds and reloading promptly turns a 25s fixed cost
 * into one of a few seconds, and bounding the whole preamble means a page that is
 * genuinely broken ends here, in this spec's own words, rather than at a ceiling
 * that names neither the url nor the status.
 */
const STARTUP_PROBE_MS = 4_000;
const STARTUP_RELOAD_PROBE_MS = 4_000;
const STARTUP_PROBE_DEADLINE_MS = 15_000;
/** How long the client is given to answer its own app entry before the startup path gives up. */
const CLIENT_WARM_DEADLINE_MS = 25_000;
/** A dependency url the optimizer serves out of this run's private cache, as the entry writes it. */
const OPTIMIZED_DEP_IN_TEXT = /["'](\/@fs\/[^"']*\/deps\/[^"']+\.js\?v=[0-9a-f]+)["']/;

/** Waits for a locator without throwing, so a caller can decide whether to retry. */
const appears = async (locator: Locator, timeoutMs: number): Promise<boolean> =>
  locator.waitFor({ state: 'visible', timeout: timeoutMs }).then(() => true, () => false);

/**
 * Commits this run's Vite dependency pre-bundle before any browser of this run navigates.
 *
 * The optimizer is per-run (a private cache directory under the data dir), so its
 * first commit always happens *during* a run, and the browser that triggers it
 * gets its document replaced mid-flight — the exact replacement the bounded probe
 * above exists to survive. Doing it here instead, over plain HTTP and before
 * `browser.newContext()`, means the criterion's first navigation meets a document
 * that stays. The proof is a dependency url current for this run: the hash is the
 * one its writer committed, so a 200 on that url is "the optimizer has committed",
 * not "something answered".
 */
async function warmClientStartup(clientUrl: string): Promise<number> {
  const startedAt = Date.now();
  const deadline = startedAt + CLIENT_WARM_DEADLINE_MS;
  const fetchWithin = async (url: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
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
}

/**
 * Reloads until the sidebar lists `workspaceName`, bounded by the preamble deadline.
 *
 * The account is already registered by the time this runs, so there is no
 * onboarding screen to wait for here: the sidebar's project row is the app's own
 * statement that it reached the backend and indexed the armed workspace, which is
 * what the rest of the case needs before it can open a session.
 */
async function awaitWorkspaceInSidebar(page: Page, workspaceName: string): Promise<number> {
  const startedAt = Date.now();
  const deadline = startedAt + STARTUP_PROBE_DEADLINE_MS;
  let listed = await appears(projectRow(page, workspaceName), STARTUP_PROBE_MS);
  while (!listed && Date.now() < deadline) {
    await page.reload();
    listed = await appears(
      projectRow(page, workspaceName),
      Math.min(STARTUP_RELOAD_PROBE_MS, Math.max(1, deadline - Date.now())),
    );
  }
  if (!listed) {
    throw new Error(`the sidebar never listed workspace "${workspaceName}" within the ${STARTUP_PROBE_DEADLINE_MS}ms startup budget`);
  }

  return Date.now() - startedAt;
}

/** The app's own chat socket, wherever it is proxied to. */
const WS_PATTERN = /\/ws(\?.*)?$/;

type Partition = {
  /** `pass` forwards both directions; `reject` refuses every connection outright. */
  mode: 'pass' | 'reject';
  closeLive: () => void;
};

/**
 * Puts the app's own socket behind a partition, so this file can take the
 * unreachable reading without killing the server (killing it trips the 40s boot
 * guard and poisons the other cases in this invocation). The mechanism is the
 * one `e2e/activity-dock-truthful.spec.ts` established: `page.routeWebSocket`
 * intercepts `/ws`, `connectToServer()` reaches the real server, and the mode
 * decides whether frames flow. `reject` closes each connection outright, which
 * is "no server" to the page: the socket drops and every reconnect is refused.
 */
async function installPartition(page: Page, partition: Partition): Promise<void> {
  await page.routeWebSocket(WS_PATTERN, (ws) => {
    if (partition.mode === 'reject') {
      void ws.close({ code: 1006 });
      return;
    }
    const server = ws.connectToServer();
    partition.closeLive = () => {
      void ws.close({ code: 1006 });
    };
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => ws.send(message));
  });
}

/** One task row by id. */
const taskRowOf = (page: Page, taskId: string): Locator =>
  page.locator(`[data-activity-task-row][data-task-id="${taskId}"]`);

/** The task ids the panel is listing right now. */
async function readTaskIds(page: Page): Promise<string[]> {
  return page
    .locator(TASK_ROW)
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-task-id') ?? '').filter((id) => id.length > 0));
}

/**
 * The AC3 reading function, reused by the false-form arm below.
 *
 * "The click did not change the row" is `before === after` with both readings a
 * real non-terminal state. The main arm passes the row's state read just before
 * and just after the click; the false-form arm passes `running` then `stopped`
 * (what an optimistic click would produce) and must come back red.
 */
function clickInstantVerdict(before: string | null, after: string | null): { green: boolean; reading: string } {
  return {
    green: before !== null && after !== null && before === after,
    reading: `click-instant: before=${before} after=${after}`,
  };
}

/**
 * Releases the control walk's `await-release` barrier, which is what lets the
 * scenario's stop and background events fire.
 *
 * Called once this case's click window has closed. Until it lands the walk is
 * parked at the barrier, so the readings that have to come first — "the click did
 * not change the row", "the background task is not drawn yet" — hold because the
 * events have not happened, not because a fixed offset happened to outrun the
 * clicks on this host. A release that fails is reported here rather than left to
 * the polls below, so a red names the handshake instead of a row that never moved.
 */
async function releaseControlWalk(api: APIRequestContext, sessionId: string): Promise<void> {
  const response = await api.post('/api/debug-agent/release', { data: { sessionId } });
  const body = (await response.json().catch(() => null)) as { success?: boolean; data?: { woken?: number } } | null;
  console.log(`release.status=${response.status()} release.body=${JSON.stringify(body).slice(0, 200)}`);
  expect(response.ok(), `the walk must be released: ${JSON.stringify(body).slice(0, 300)}`).toBe(true);
}

test.describe('activity dock controls', () => {
  let page: Page;
  let api: APIRequestContext;
  let workspace = '';
  let sessionId = '';
  let partition: Partition = { mode: 'pass', closeLive: () => undefined };

  test.beforeAll(async ({ browser }) => {
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');
    const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
    if (!fixtureHome) throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME');
    if (!process.env.QUAY_E2E_RUN_STARTED_AT) throw new Error('playwright.config.ts must publish QUAY_E2E_RUN_STARTED_AT');

    workspace = path.join(fixtureHome, 'activity-dock-controls-workspace');
    const workspaceName = path.basename(workspace);

    // The account this file already registered for AC-194; `createAccount` falls
    // through to a sign-in when the registration is already taken.
    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();
    api = await request.newContext({ baseURL: clientUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });

    sessionId = await armScenario(api, workspace, CONTROL_SCENARIO);

    // Before `browser.newContext()`, and therefore before any page of this run exists, so this run's
    // own optimizer commit happens outside the criterion's first navigation — see the helper.
    console.log(`[e2e] client warm-up: ${await warmClientStartup(clientUrl)}ms`);

    const context = await browser.newContext({ baseURL: clientUrl });
    await context.addInitScript(
      ({ key, value }: { key: string; value: string }) => {
        window.localStorage.setItem(key, value);
        window.localStorage.setItem('userLanguage', 'en');
      },
      { key: 'auth-token', value: token },
    );
    page = await context.newPage();
    // Installed before the app ever opens its socket: the first connection must
    // already travel through the fixture for the unreachable reading to hold.
    await installPartition(page, partition);
    page.on('pageerror', (error) => console.log(`[e2e] pageerror: ${error.message}`));

    await page.goto('/');
    console.log(`[e2e] sidebar ready: ${await awaitWorkspaceInSidebar(page, workspaceName)}ms`);
    await revealSession(page, workspaceName, sessionId);
  });

  test.afterAll(async () => {
    await page?.close();
    await api?.dispose();
  });

  test('AC-199 the dock stops a task and backgrounds a foreground tool, only on the server’s events', async () => {
    const runStartedAt = Number(process.env.QUAY_E2E_RUN_STARTED_AT);

    // Fire the walk without awaiting it: the click window opens while it is in
    // flight, and the controls' events sit behind the walk's release barrier,
    // which this case does not state until that window has closed.
    const clock = api
      .post('/api/debug-agent/clock', { data: { sessionId } })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as { success?: boolean } | null;
        console.log(`clock.status=${response.status()} clock.body=${JSON.stringify(body).slice(0, 300)}`);
        return { ok: response.ok(), body };
      })
      .catch((error: unknown) => ({ ok: false, body: { failed: String(error) } }));

    // Open the session while the walk is in flight, so the subscribe attaches and the
    // transcript (the foreground tool's source) is loaded before the click window closes.
    await page.waitForTimeout(600);
    await sessionRow(page, sessionId).click();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });

    await expect(page.locator(DOCK_TOGGLE)).toBeVisible({ timeout: 20_000 });
    await page.locator(DOCK_TOGGLE).click();
    await expect(page.locator(PANEL)).toBeVisible({ timeout: 15_000 });

    // --- AC2: the *live* states are on screen, and the terminal one is not ---------------------
    await expect(taskRowOf(page, STOP_TARGET)).toBeVisible({ timeout: 20_000 });
    await expect(taskRowOf(page, NEVER_TASK)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(FOREGROUND_ROW)).toBeVisible({ timeout: 20_000 });
    // `TERMINAL_TASK` is a row in the snapshot (asserted below) but never a row in the panel: the
    // dock lists current activity, so a task that had already settled before the page opened is
    // absent from it — the same reading the live task gets when its own event settles it.
    await expect(taskRowOf(page, TERMINAL_TASK)).toHaveCount(0);

    const { status: snapStatus, snapshot } = await readActivitySnapshot(api, sessionId);
    const snapshotTasks = snapshot?.tasks ?? [];
    const domTaskIds = (await readTaskIds(page)).sort();
    console.log(`ac2.snapshot.status=${snapStatus} snapshot.tasks=${JSON.stringify(snapshotTasks.map((t) => `${t.taskId}:${t.state}`))} dom.tasks=${JSON.stringify(domTaskIds)} foreground=${await page.locator(FOREGROUND_ROW).getAttribute('data-tool-use-id')}`);
    expect(snapStatus).toBe(200);
    expect(snapshotTasks.find((t) => t.taskId === STOP_TARGET)?.state).toBe('running');
    expect(snapshotTasks.find((t) => t.taskId === TERMINAL_TASK)?.state).toBe('completed');
    expect(snapshotTasks.some((t) => t.taskId === BG_TASK), 'the background task must not exist before its event').toBe(false);

    const stopRunning = await taskRowOf(page, STOP_TARGET).getAttribute('data-task-state');
    console.log(`ac2.stopTarget.state=${stopRunning}`);
    expect(stopRunning, 'the stop target must still be running when the click window opens').toBe('running');

    // The foreground tool is deliberately NOT a snapshot task: it has no row until the
    // CLI backgrounds it, which is the whole difference the background control acts on.
    const foregroundToolUseId = await page.locator(FOREGROUND_ROW).getAttribute('data-tool-use-id');
    expect(typeof foregroundToolUseId === 'string' && foregroundToolUseId.length > 0).toBe(true);
    expect(snapshotTasks.some((task) => (task as { toolUseId?: string }).toolUseId === foregroundToolUseId)).toBe(false);

    // --- AC5: the stop control belongs to the live rows, and only to them ----------------------
    // A terminal task has no row at all (the stronger form of "a terminal row renders no stop"):
    // the panel's list *is* the live set, so the selector's count is the live-task count.
    const terminalRowCount = await taskRowOf(page, TERMINAL_TASK).count();
    const liveRows = await page.locator(TASK_ROW).count();
    const liveStops = await page.locator(TASK_ROW).locator(TASK_STOP).count();
    console.log(`ac5.terminalRows=${terminalRowCount} liveRows=${liveRows} liveStops=${liveStops}`);
    expect(terminalRowCount, 'a settled task must not be listed by the panel').toBe(0);
    expect(liveRows, 'the panel lists exactly the two live tasks').toBe(2);
    expect(liveStops, 'every listed row is live, so every listed row carries a stop').toBe(liveRows);

    // --- AC3: stop is not optimistic -----------------------------------------------------------
    const beforeClick = await taskRowOf(page, STOP_TARGET).getAttribute('data-task-state');
    await taskRowOf(page, STOP_TARGET).locator(TASK_STOP).click();
    const afterClick = await taskRowOf(page, STOP_TARGET).getAttribute('data-task-state');
    const mainVerdict = clickInstantVerdict(beforeClick, afterClick);
    console.log(`ac3.main ${mainVerdict.reading} green=${mainVerdict.green}`);
    expect(mainVerdict.green, `the click must not change the row; ${mainVerdict.reading}`).toBe(true);
    expect(afterClick, 'the row must still read its pre-click state').toBe('running');

    // --- AC4: backgrounding is not optimistic --------------------------------------------------
    // The background click happens in the same early window, before the event that creates the
    // task. The click's task must not be in the panel until the server's own frames arrive.
    const idsBeforeBackground = await readTaskIds(page);
    console.log(`ac4.idsBeforeBackground=${JSON.stringify(idsBeforeBackground)}`);
    expect(idsBeforeBackground.includes(BG_TASK), 'the background task must not be drawn before its event').toBe(false);

    await page.locator(BACKGROUND_TOOL).click();
    const idsAfterClick = await readTaskIds(page);
    expect(idsAfterClick.includes(BG_TASK), 'a background click must not fabricate a task row').toBe(false);

    // --- Release the walk now that the click window has closed ---------------------------------
    // The walk is parked at its `await-release` barrier until this lands, so neither event below can
    // have fired before either click-instant reading above — the readings are facts about events
    // that have not happened, not a fixed offset that had to outrun two clicks.
    await releaseControlWalk(api, sessionId);

    // --- The two events, behind the barrier, are what move the state ---------------------------
    // The stop event settles the task; the background frames create the task. The click was not
    // optimistic (asserted above: the row read `running` on both sides of it), so the row can only
    // leave the panel because the server's own frame made the task terminal. The snapshot is read
    // back for the state the panel no longer draws.
    await expect(taskRowOf(page, STOP_TARGET)).toHaveCount(0, { timeout: 20_000 });
    await expect
      .poll(
        async () =>
          (await readActivitySnapshot(api, sessionId)).snapshot?.tasks?.find((t) => t.taskId === STOP_TARGET)?.state,
        { timeout: 20_000 },
      )
      .toBe('stopped');
    console.log('ac3.settled: the stop event settled the task, and the panel dropped its row');

    await expect(taskRowOf(page, BG_TASK)).toBeVisible({ timeout: 20_000 });
    // The task the event created names the very foreground tool the control addressed: its
    // `toolUseId` is the pending tool's id, which is what makes "this task is that tool".
    const bgSnapshot = await readActivitySnapshot(api, sessionId);
    const bgTask = bgSnapshot.snapshot?.tasks?.find((t) => t.taskId === BG_TASK) as
      | { state?: string; toolUseId?: string }
      | undefined;
    console.log(`ac4.backgrounded: bgTask=${BG_TASK} state=${bgTask?.state} toolUseId=${bgTask?.toolUseId ?? '<none>'} foreground=${foregroundToolUseId}`);
    expect(bgTask?.state).toBe('running');
    expect(bgTask?.toolUseId, 'the backgrounded task must join the foreground tool the control addressed').toBe(foregroundToolUseId);

    // --- AC7: the false form is red under the same reading function ---------------------------
    const falseFormVerdict = clickInstantVerdict('running', 'stopped');
    console.log(`ac7.falseForm ${falseFormVerdict.reading} green=${falseFormVerdict.green}`);
    expect(
      falseFormVerdict.green,
      'an optimistic click (running -> stopped with no event) must read red under the AC3 reading',
    ).toBe(false);
    expect(mainVerdict.reading).not.toBe(falseFormVerdict.reading);

    // --- AC6: a partition disables both controls, with a reason -------------------------------
    // The dock's state attribute is not read here: with no turn in flight and tasks held,
    // the dock draws `background` rather than `unreachable` — the *liveness* is what the
    // controls go by, and it is what this reading takes. What the AC requires is the DOM's
    // own `disabled` plus a reason, so that is what is asserted.
    partition.mode = 'reject';
    partition.closeLive();

    const stopButton = taskRowOf(page, NEVER_TASK).locator(TASK_STOP);
    const backgroundButton = page.locator(BACKGROUND_TOOL);
    await expect(stopButton).toBeDisabled({ timeout: 15_000 });
    await expect(backgroundButton).toBeDisabled({ timeout: 15_000 });
    const dockState = await page.locator('[data-activity-dock]').getAttribute('data-activity-state');
    const reasonTexts = await page.locator(DISABLED_REASON).evaluateAll((nodes) =>
      nodes.map((node) => (node.textContent ?? '').trim()),
    );
    console.log(`ac6.partition: dockState=${dockState} stopDisabled=${await stopButton.isDisabled()} bgDisabled=${await backgroundButton.isDisabled()} reasons=${JSON.stringify(reasonTexts)}`);
    expect(reasonTexts.length, 'each disabled control must draw a reason').toBeGreaterThanOrEqual(2);
    expect(reasonTexts.every((text) => text.length > 0), 'a disabled reason must not be blank').toBe(true);

    // --- The walk itself completed -------------------------------------------------------------
    const clockBody = await clock;
    expect(clockBody.ok, `the walk must complete: ${JSON.stringify(clockBody)}`).toBe(true);
    expect(clockBody.body?.success, `the walk must report success: ${JSON.stringify(clockBody.body)}`).toBe(true);

    // --- AC1: the wall clock ------------------------------------------------------------------
    const elapsedMs = Date.now() - runStartedAt;
    console.log(`AC-199 wall clock: ${elapsedMs}ms`);
    expect(elapsedMs, 'the criterion must complete within 40s').toBeLessThanOrEqual(40_000);
  });
});

// =============================================================================================
// The capability gate, on a real browser against a real server.
//
// AC-199 pins what the control *does* when a session is placeable; this block pins
// the case AC-199's substitute could never reach: a **resident** session whose
// provider declares no stop verb. The matrix is the same one the server refuses
// on, read here from `GET /api/providers/capabilities` through the page's own
// server; the provider is the debug agent, which declares `resident` as a
// lifecycle mode but no `residentFeatures` at all — so it is exactly the
// "unmeasured ⇒ unsupported" shape the shipped claude row used to have, and the
// one a reader must not be told is placeable.
//
// The reading is the DOM's own `disabled` plus the reason drawn beside it. Before
// this change the control was enabled here and a click reached the server to be
// refused, with nothing on screen saying so — "clickable but silently inert",
// which is the shape this arm exists to keep out.
// =============================================================================================

const GATE_TITLE = 'Activity dock controls — capability gate';
const GATE_SEED = 'seeded user turn for the activity-dock capability-gate criterion';
const GATE_TASK = 'task-capability-gate';

/**
 * One live task on a resident session, and nothing else. The walk writes three
 * rows; the task never settles, so the panel holds one live row for the whole
 * reading.
 */
const GATE_SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: GATE_TITLE, userText: GATE_SEED, lifecycleMode: 'resident' },
  steps: [
    { at: 0, op: 'tool-call', name: 'Bash' },
    { at: 200, op: 'task-started', taskId: GATE_TASK, taskType: 'local_bash', description: 'Watcher stays up' },
    { at: 400, op: 'row', role: 'assistant', text: 'The watcher is running.' },
    { at: 1_200, op: 'wait' },
  ],
  expect: { rows: { delta: 3 }, content: { mustContain: [GATE_SEED] } },
};

/** One session's row on `GET /api/session-hosts`, as this arm reads it. */
type HostStateRow = { appSessionId: string; provider: string; lifecycleMode: string; running: boolean };

async function readHostState(api: APIRequestContext, sessionId: string): Promise<HostStateRow | null> {
  const response = await api.get('/api/session-hosts');
  const body = await response.json().catch(() => null);
  const rows = (body?.data?.sessions ?? []) as HostStateRow[];
  return rows.find((row) => row.appSessionId === sessionId) ?? null;
}

/** One provider's capability row, as `GET /api/providers/capabilities` states it. */
type CapabilityRow = { provider: string; residentFeatures?: { stopTask?: boolean } | null };

async function readCapabilityRow(api: APIRequestContext, provider: string): Promise<CapabilityRow | null> {
  const response = await api.get('/api/providers/capabilities');
  const body = await response.json().catch(() => null);
  const rows = (body?.data?.providers ?? []) as CapabilityRow[];
  return rows.find((row) => row.provider === provider) ?? null;
}

/**
 * The gate's rule, written once so the arm and its false form drive the same
 * function: a control must be disabled by capability exactly when the session is
 * resident and the matrix does not declare the verb, and the DOM must agree.
 *
 * Agreement — not "the DOM is disabled" — is what is asserted, because a build
 * that disabled the control for some unrelated reason would satisfy the weaker
 * reading. The false form passes the reading a gate-free build produces
 * (undeclared resident provider, control still enabled) and must come back red.
 */
function capabilityGateAgreement(input: {
  lifecycleMode: string;
  declared: boolean | undefined;
  domDisabled: boolean;
}): { green: boolean; reading: string } {
  const shouldBeDisabled = input.lifecycleMode === 'resident' && input.declared !== true;
  return {
    green: shouldBeDisabled === input.domDisabled,
    reading:
      `capability-gate: lifecycleMode=${input.lifecycleMode} declared=${String(input.declared)} ` +
      `shouldBeDisabled=${String(shouldBeDisabled)} domDisabled=${String(input.domDisabled)}`,
  };
}

test.describe('activity dock capability gate', () => {
  let page: Page;
  let api: APIRequestContext;
  let workspace = '';
  let sessionId = '';

  test.beforeAll(async ({ browser }) => {
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');
    const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
    if (!fixtureHome) throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME');

    workspace = path.join(fixtureHome, 'activity-dock-capability-workspace');
    const workspaceName = path.basename(workspace);

    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();
    api = await request.newContext({ baseURL: clientUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });

    sessionId = await armScenario(api, workspace, GATE_SCENARIO);

    const context = await browser.newContext({ baseURL: clientUrl });
    await context.addInitScript(
      ({ key, value }: { key: string; value: string }) => {
        window.localStorage.setItem(key, value);
        window.localStorage.setItem('userLanguage', 'en');
      },
      { key: 'auth-token', value: token },
    );
    page = await context.newPage();
    page.on('pageerror', (error) => console.log(`[e2e] pageerror: ${error.message}`));

    await page.goto('/');
    if (!(await projectRow(page, workspaceName).waitFor({ state: 'visible', timeout: 25_000 }).then(() => true, () => false))) {
      await page.reload();
    }
    await revealSession(page, workspaceName, sessionId);
  });

  test.afterAll(async () => {
    await page?.close();
    await api?.dispose();
  });

  test('a resident session whose provider declares no stop verb draws a disabled stop with a reason', async () => {
    // The walk starts the session's task; the reading is taken with the panel open.
    const clock = api
      .post('/api/debug-agent/clock', { data: { sessionId } })
      .then(async (response) => ({ ok: response.ok(), body: await response.json().catch(() => null) }))
      .catch((error: unknown) => ({ ok: false, body: { failed: String(error) } }));

    await page.waitForTimeout(600);
    await sessionRow(page, sessionId).click();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(DOCK_TOGGLE)).toBeVisible({ timeout: 20_000 });
    await page.locator(DOCK_TOGGLE).click();
    await expect(page.locator(PANEL)).toBeVisible({ timeout: 15_000 });
    await expect(taskRowOf(page, GATE_TASK)).toBeVisible({ timeout: 20_000 });

    // The two facts the gate is a function of, read off the wire rather than
    // assumed: the session really is resident, and the matrix really declares no
    // resident stop verb for its provider.
    const hostState = await readHostState(api, sessionId);
    const capabilityRow = await readCapabilityRow(api, hostState?.provider ?? '');
    console.log(
      `capabilityGate.host=${JSON.stringify(hostState)} capabilityRow=${JSON.stringify(capabilityRow)}`,
    );
    expect(hostState?.lifecycleMode, 'this arm needs a resident session, or it reads the wrong gate').toBe('resident');
    expect(
      capabilityRow?.residentFeatures?.stopTask,
      'this arm needs a provider the matrix does not declare a resident stop for',
    ).not.toBe(true);

    const stopButton = taskRowOf(page, GATE_TASK).locator(TASK_STOP);
    const domDisabled = await stopButton.isDisabled();
    const reasonTexts = await taskRowOf(page, GATE_TASK)
      .locator(DISABLED_REASON)
      .evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? '').trim()));

    const mainVerdict = capabilityGateAgreement({
      lifecycleMode: hostState?.lifecycleMode ?? '',
      declared: capabilityRow?.residentFeatures?.stopTask,
      domDisabled,
    });
    console.log(
      `capabilityGate.main ${mainVerdict.reading} green=${String(mainVerdict.green)} reasons=${JSON.stringify(reasonTexts)}`,
    );

    expect(mainVerdict.green, `the DOM must agree with the capability face; ${mainVerdict.reading}`).toBe(true);
    expect(domDisabled, 'the control must not be placeable when the provider declares no verb').toBe(true);
    expect(reasonTexts.length, 'a disabled control must draw its reason').toBeGreaterThanOrEqual(1);
    expect(reasonTexts.every((text) => text.length > 0), 'a disabled reason must not be blank').toBe(true);

    // --- the false form, under the same reading function --------------------------------------
    // What a build that never reads the matrix draws: the same resident provider,
    // the same missing declaration, and a control that still looks placeable. The
    // reading must come back red, which is what makes the green above evidence
    // about the gate rather than about the fixture.
    const falseFormVerdict = capabilityGateAgreement({
      lifecycleMode: 'resident',
      declared: capabilityRow?.residentFeatures?.stopTask,
      domDisabled: false,
    });
    console.log(`capabilityGate.falseForm ${falseFormVerdict.reading} green=${String(falseFormVerdict.green)}`);
    expect(falseFormVerdict.green, 'an enabled control on an undeclared resident provider must read red').toBe(false);
    expect(mainVerdict.reading).not.toBe(falseFormVerdict.reading);

    const clockBody = await clock;
    expect(clockBody.ok, `the walk must complete: ${JSON.stringify(clockBody)}`).toBe(true);
  });
});
