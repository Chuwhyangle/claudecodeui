/**
 * The scenario runner, end to end: a real app, a real Quay wall, one JSON scenario.
 *
 * WHAT THIS FILE IS THE READING OF. A business scenario is 15–20 steps, and the state it
 * asserts — focus, the visible set, the tray, the input pack — is mostly not in the DOM.
 * `scripts/ui-scenario.mjs` drives those steps through the dev-only semantic surface
 * (`window.__cloudcliScenario`) and asserts structured readings, so this criterion boots the
 * runner against the real client and server and reads its report.
 *
 * TWO ARMS, ONE ENTRY POINT. The main arm runs `e2e/scenarios/quay-wall-focus-pin-utter.json`
 * (six steps: open the Quay view, focus by the ordinal a person says, move the focus, pin it,
 * utter, then read the input pack) and expects a green report whose checkpoint screenshots exist
 * and are non-empty. The control arm copies the SAME scenario and changes exactly one
 * expectation — step 3's `focusLabel` — and expects a non-zero exit whose report names step 3 as
 * the failure. Both arms invoke the same `scripts/ui-scenario.mjs`; only the scenario file differs,
 * which is what makes the runner's exit code and `failedStep` a real reading rather than a claim.
 *
 * THE FIXTURE. A project directory the app discovers (via a transcript), carrying a
 * `.quay/config.yml` and the repository's own plugin wiring, two `ready` tasks, and a
 * `.quay/worker-round.jsonl` line that names both as in flight — quay's `lanes` verb derives the
 * in-flight set from that round carrier, so the wall's In-flight tile declares two focusable
 * objects (① and ②) without any stubbing of the API. The seed is written before the first
 * navigation, and the spec waits for the project to be indexed before the runner starts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { expect, request, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

const CLIENT_URL = `http://127.0.0.1:${process.env.QUAY_E2E_CLIENT_PORT}`;
const DATA_DIR = process.env.QUAY_E2E_DATA_DIR ?? '';
/** The checkout this spec runs from: the fixture reuses its quay plugin wiring and the runner path. */
const REPO_ROOT = path.resolve(process.cwd());

const WORKSPACE = path.join(DATA_DIR, 'ui-scenario-workspace');
const SESSION_ID = 'e2e-ui-scenario';
const SESSION_NAME = 'ui-scenario-wall';
const WORKSPACE_NAME = path.basename(WORKSPACE);

/** The two fixture tasks the round carrier names in flight, earliest start first. */
const TASK_A = 'gap-wall-focus-a';
const TASK_B = 'gap-wall-focus-b';

const AUTH_TOKEN_KEY = 'auth-token';
const USERNAME = 'e2euser';
const PASSWORD = 'e2epassword';

/** The scenario under test, and the runner both arms invoke. */
const SCENARIO_FILE = path.join(REPO_ROOT, 'e2e', 'scenarios', 'quay-wall-focus-pin-utter.json');
const RUNNER = path.join(REPO_ROOT, 'scripts', 'ui-scenario.mjs');

/** Where the arms write their reports and checkpoint screenshots. */
const MAIN_OUT = path.join(REPO_ROOT, 'tmp', 'ui-scenarios', 'e2e-main');
const CONTROL_OUT = path.join(REPO_ROOT, 'tmp', 'ui-scenarios', 'e2e-control');

type ScenarioStep = { open?: string; drive?: Record<string, unknown>; expect?: Record<string, unknown>; checkpoint?: boolean };
type Scenario = { name?: string; description?: string; steps: ScenarioStep[] };
type RunnerReport = {
  scenario: string;
  ok: boolean;
  failedStep: number | null;
  stepCount: number;
  checkpoints: { step: number; file: string }[];
  steps: { index: number; action: string; ok: boolean; failures: string[]; screenshot: string | null }[];
};

/**
 * Writes the fixture project.
 *
 * The plugin link mirrors the repository's own `.quay/plugin` target rather than restating a
 * vendored path, so the fixture keeps working when the installed plugin version moves. The round
 * carrier is what makes the wall's In-flight tile declare focusables: quay's `readLive` merges
 * `.quay/worker-round.jsonl`'s `in_flight_tasks` into its in-flight set, and the panel's focusable
 * contract is built from that same `lanes` reading.
 */
/**
 * The quay plugin directory the fixture's `.quay/plugin` link points at.
 *
 * A TASK WORKTREE HAS NO LOCAL `.quay/`: that tree is operator state, not checked in, so
 * `dispatch-worktree-setup.sh` does not copy it and the mobile-grid spec's `REPO_ROOT/.quay/plugin`
 * reading (which only ever runs from the main checkout) does not resolve here. The server spawns
 * `<projectRoot>/.quay/plugin/bin/quay`, so the fixture needs SOME real plugin; when the checkout
 * has one it is used verbatim (the same wiring the repo runs on), and otherwise the installed
 * plugin cache — the one the drivers themselves run from — supplies the newest version. The
 * version is never restated: a path is discovered, not pinned.
 */
const resolveQuayPlugin = (): string => {
  const repoPlugin = path.join(REPO_ROOT, '.quay', 'plugin');
  if (fs.existsSync(repoPlugin)) {
    return fs.realpathSync(repoPlugin);
  }
  const cache = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'quay', 'quay');
  const versions = fs.existsSync(cache)
    ? fs.readdirSync(cache).filter((version) => fs.existsSync(path.join(cache, version, 'bin', 'quay')))
    : [];
  if (versions.length === 0) {
    throw new Error(
      `no quay plugin to wire into the fixture: neither ${repoPlugin} nor an install under ${cache}`,
    );
  }
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return path.join(cache, versions[versions.length - 1] as string);
};

const seedFixtureProject = (): void => {
  const quayDir = path.join(WORKSPACE, '.quay');
  const tasksDir = path.join(WORKSPACE, 'tasks');
  const goalDir = path.join(WORKSPACE, 'goals');
  const adrDir = path.join(WORKSPACE, 'adr');
  const metaDir = path.join(WORKSPACE, 'meta');
  for (const dir of [quayDir, tasksDir, goalDir, adrDir, metaDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const pluginLink = path.join(quayDir, 'plugin');
  fs.rmSync(pluginLink, { recursive: true, force: true });
  fs.symlinkSync(resolveQuayPlugin(), pluginLink);

  fs.writeFileSync(
    path.join(quayDir, 'config.yml'),
    [
      'providers:',
      '  native:',
      '    enabled: true',
      `    tasks_dir: "${tasksDir}"`,
      '    env:',
      `      QUAY_NATIVE_TASKS_DIR: "${tasksDir}"`,
      `      QUAY_NATIVE_GOAL_DIR: "${goalDir}"`,
      `      QUAY_NATIVE_ADR_DIR: "${adrDir}"`,
      `      QUAY_NATIVE_META_DIR: "${metaDir}"`,
      'loop:',
      `  repo_root: ${WORKSPACE}`,
      '  fork_baseline: develop',
      '',
    ].join('\n'),
    'utf8',
  );

  for (const [id, title] of [
    [TASK_A, 'First wall object'],
    [TASK_B, 'Second wall object'],
  ] as const) {
    fs.writeFileSync(
      path.join(tasksDir, `${id}.md`),
      ['---', `id: ${id}`, `title: ${title}`, 'status: ready', '---', 'A fixture task in flight for the scenario.', ''].join('\n'),
      'utf8',
    );
  }

  // The round carrier: quay's `readLive` reads `in_flight_tasks` plus their start instants and
  // reports both tasks as in flight (phase `implementing`, no fan-in lock held). The starts are
  // ordered so A is ① and B is ② — the scenario's `move down` relies on that spatial order.
  const now = Date.now();
  fs.writeFileSync(
    path.join(quayDir, 'worker-round.jsonl'),
    `${JSON.stringify({
      ts: new Date(now).toISOString(),
      in_flight_tasks: [TASK_A, TASK_B],
      in_flight_task_starts: {
        [TASK_A]: new Date(now - 120_000).toISOString(),
        [TASK_B]: new Date(now - 60_000).toISOString(),
      },
      pid: process.pid,
    })}\n`,
    'utf8',
  );

  const transcriptDir = path.join(DATA_DIR, '.claude', 'projects', WORKSPACE_NAME);
  fs.mkdirSync(transcriptDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const records = [
    {
      type: 'user',
      sessionId: SESSION_ID,
      cwd: WORKSPACE,
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'open the quay wall for the scenario reading' }] },
    },
    { type: 'custom-title', sessionId: SESSION_ID, cwd: WORKSPACE, timestamp, customTitle: SESSION_NAME },
  ];
  fs.writeFileSync(
    path.join(transcriptDir, `${SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
};

/** An account this run owns, created over the API. */
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
    throw new Error(
      `could not create or sign in as ${USERNAME}: register ${register.status()} ${JSON.stringify(registered)}, `
      + `login ${login.status()} ${JSON.stringify(loggedIn)}`,
    );
  }
  return loggedIn.token;
}

/**
 * Drives `GET /api/projects` — which runs the session synchronizer — until the fixture is listed.
 *
 * A project the app has not indexed offers no Quay view, so the runner would fail at its first
 * step for a reason outside what it measures. A `hasQuayConfig:false` row is a hard fail: no
 * amount of waiting writes a `.quay/config.yml`.
 */
const waitForFixtureProject = async (api: APIRequestContext, budgetMs = 30_000): Promise<void> => {
  const deadline = Date.now() + budgetMs;
  let last = 'never asked';
  while (Date.now() < deadline) {
    const response = await api.get('/api/projects');
    if (response.ok()) {
      const projects = (await response.json()) as { fullPath?: string; path?: string; hasQuayConfig?: boolean }[];
      const row = projects.find((project) => (project.fullPath ?? project.path) === WORKSPACE);
      if (row) {
        if (!row.hasQuayConfig) {
          throw new Error(`the fixture project was indexed without a quay config at ${WORKSPACE}`);
        }
        return;
      }
      last = `GET /api/projects listed no project at ${WORKSPACE}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the fixture project never appeared after ${budgetMs}ms: ${last}`);
};

/** Runs the runner and parses the report it printed on stdout. */
const runRunner = (scenarioFile: string, outDir: string, token: string) => {
  const result = spawnSync(
    process.execPath,
    [
      RUNNER,
      scenarioFile,
      '--base-url', CLIENT_URL,
      '--auth-token', token,
      '--project', WORKSPACE_NAME,
      '--session', SESSION_NAME,
      '--out', outDir,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  let report: RunnerReport | null = null;
  try {
    report = JSON.parse(stdout) as RunnerReport;
  } catch {
    report = null;
  }
  return { status: result.status, stdout, stderr, report };
};

test.describe('the UI scenario runner on the Quay wall', () => {
  test('runs the wall scenario green, and names the failing step when an expectation is wrong', async () => {
    test.setTimeout(240_000);
    seedFixtureProject();

    const bootstrap = await request.newContext({ baseURL: CLIENT_URL });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();
    const api = await request.newContext({
      baseURL: CLIENT_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });

    try {
      await waitForFixtureProject(api);
    } finally {
      await api.dispose();
    }

    fs.rmSync(MAIN_OUT, { recursive: true, force: true });
    fs.rmSync(CONTROL_OUT, { recursive: true, force: true });

    // ── main arm: the scenario as written ────────────────────────────────────────────────────
    const main = runRunner(SCENARIO_FILE, MAIN_OUT, token);
    expect(main.stderr, `the runner must print only its report on stdout\nstdout=${main.stdout}`).toContain('ui-scenario:');
    expect(main.status, `main arm must exit 0\nstdout=${main.stdout}\nstderr=${main.stderr}`).toBe(0);
    expect(main.report, `main arm must print a JSON report\nstdout=${main.stdout}\nstderr=${main.stderr}`).not.toBeNull();
    const mainReport = main.report as RunnerReport;

    expect(mainReport.ok, `main report must be ok: ${JSON.stringify(mainReport.steps)}`).toBe(true);
    expect(mainReport.failedStep).toBeNull();
    expect(mainReport.stepCount).toBeGreaterThanOrEqual(6);
    expect(mainReport.steps.every((step) => step.ok), JSON.stringify(mainReport.steps)).toBe(true);
    expect(mainReport.checkpoints.length).toBeGreaterThanOrEqual(1);

    for (const checkpoint of mainReport.checkpoints) {
      expect(fs.existsSync(checkpoint.file), `checkpoint screenshot ${checkpoint.file} must exist`).toBe(true);
      expect(fs.statSync(checkpoint.file).size, `checkpoint screenshot ${checkpoint.file} must be non-empty`).toBeGreaterThan(0);
    }

    // ── control arm: the SAME scenario, one expectation deliberately wrong ──────────────────
    const scenario = JSON.parse(fs.readFileSync(SCENARIO_FILE, 'utf8')) as Scenario;
    const mutatedIndex = 2; // step 3: after `move down` from ① the focus must be ②, not ①
    expect(scenario.steps[mutatedIndex]?.expect?.focusLabel, 'the control arm mutates a step that originally expects ②').toBe('②');
    scenario.steps[mutatedIndex] = {
      ...scenario.steps[mutatedIndex],
      expect: { ...scenario.steps[mutatedIndex]?.expect, focusLabel: '①' },
    };
    scenario.name = 'quay-wall-focus-pin-utter-control';
    fs.mkdirSync(CONTROL_OUT, { recursive: true });
    const controlScenario = path.join(CONTROL_OUT, 'scenario.json');
    fs.writeFileSync(controlScenario, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');

    const control = runRunner(controlScenario, CONTROL_OUT, token);
    expect(control.status, `control arm must exit non-zero\nstdout=${control.stdout}\nstderr=${control.stderr}`).toBe(1);
    expect(control.report, `control arm must still print a report\nstdout=${control.stdout}`).not.toBeNull();
    const controlReport = control.report as RunnerReport;

    expect(controlReport.ok).toBe(false);
    expect(controlReport.failedStep, 'the report must name the step that was mutated').toBe(mutatedIndex + 1);
    const failed = controlReport.steps[mutatedIndex];
    expect(failed?.ok, `step ${mutatedIndex + 1} must be the failed one: ${JSON.stringify(failed)}`).toBe(false);
    expect(failed?.failures.join('\n') ?? '', 'the failure must name the expectation it read').toContain('focusLabel');

    // Every step before the mutated one still passed, so the failure is the mutation and not a
    // run that fell over earlier and happened to number the same step.
    for (const step of controlReport.steps.slice(0, mutatedIndex)) {
      expect(step.ok, `control step ${step.index} must pass: ${JSON.stringify(step)}`).toBe(true);
    }
  });
});
