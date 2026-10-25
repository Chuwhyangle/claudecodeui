/**
 * The scenario runner, end to end: a real app, a real Quay wall, one JSON scenario.
 *
 * WHAT THIS FILE IS THE READING OF. A business scenario is 15–20 steps, and the state it
 * asserts — focus, the visible set, the tray, the input pack — is mostly not in the DOM.
 * `scripts/ui-scenario.mjs` drives those steps through the dev-only semantic surface
 * (`window.__cloudcliScenario`) and asserts structured readings, so this criterion boots the
 * runner against the real client and server and reads its report.
 *
 * TWO ARMS, ONE ENTRY POINT. The main arm runs a scenario file as written and expects a green
 * report whose checkpoint screenshots exist and are non-empty. The control arm copies the SAME
 * scenario and changes exactly one expectation, and expects a non-zero exit whose report names
 * that step as the failure. Both arms invoke the same `scripts/ui-scenario.mjs`; only the
 * scenario file differs, which is what makes the runner's exit code and `failedStep` a real
 * reading rather than a claim.
 *
 * TWO SCENARIO FAMILIES, ONE SPEC. The Quay wall scenario (focus by the ordinal a person says,
 * move, pin, utter) is the pre-existing family. The cockpit family is navigation-shaped: a
 * person reading a session switches to the cockpit stage with the mode switch and returns to the
 * SAME session through the cockpit's recorded return path. Its readings are the route, whether
 * the cockpit page is mounted, and the cockpit's own `data-cockpit-view` declaration — not a DOM
 * snapshot. Both families use the same runner and the same two-arm shape.
 *
 * THE FIXTURE. A project directory the app discovers (via a transcript), carrying a
 * `.quay/config.yml` and the repository's own plugin wiring, two `ready` tasks, and a
 * `.quay/worker-round.jsonl` line that names both as in flight — quay's `lanes` verb derives the
 * in-flight set from that round carrier, so the wall's In-flight tile declares two focusable
 * objects (① and ②) without any stubbing of the API. The seed is written before the first
 * navigation, and the spec waits for the project to be indexed before the runner starts.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

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

const USERNAME = 'e2euser';
const PASSWORD = 'e2epassword';

/** The scenario under test, and the runner both arms invoke. */
const SCENARIO_FILE = path.join(REPO_ROOT, 'e2e', 'scenarios', 'quay-wall-focus-pin-utter.json');
/** The cockpit's navigation scenario: session → cockpit → back to the same session. */
const COCKPIT_SCENARIO_FILE = path.join(REPO_ROOT, 'e2e', 'scenarios', 'cockpit-mode-switch.json');
const RUNNER = path.join(REPO_ROOT, 'scripts', 'ui-scenario.mjs');

/** Where the arms write their reports and checkpoint screenshots. */
const MAIN_OUT = path.join(REPO_ROOT, 'tmp', 'ui-scenarios', 'e2e-main');
const CONTROL_OUT = path.join(REPO_ROOT, 'tmp', 'ui-scenarios', 'e2e-control');
const COCKPIT_MAIN_OUT = path.join(REPO_ROOT, 'tmp', 'ui-scenarios', 'e2e-cockpit-main');
const COCKPIT_CONTROL_OUT = path.join(REPO_ROOT, 'tmp', 'ui-scenarios', 'e2e-cockpit-control');
const ZERO_WIDTH_OUT = path.join(REPO_ROOT, 'tmp', 'ui-scenarios', 'e2e-zero-width');
const NO_SURFACE_OUT = path.join(REPO_ROOT, 'tmp', 'ui-scenarios', 'e2e-no-surface');

/**
 * The runner's own boot budget (`BOOT_TIMEOUT_MS` in `scripts/ui-scenario.mjs`).
 *
 * The surface-less arm asserts the runner gives up ON that budget instead of hanging; it is not
 * pinned in the runner because nothing is allowed to read this file from there. Kept as a literal
 * on purpose: a change to the runner's budget should make a reader re-check this line, not
 * silently rewrite the assertion's meaning.
 */
const BOOT_TIMEOUT_MS = 30_000;

type ScenarioStep = { open?: string; drive?: Record<string, unknown>; expect?: Record<string, unknown>; checkpoint?: boolean };
type Scenario = { name?: string; description?: string; steps: ScenarioStep[] };
type RunnerReport = {
  scenario: string;
  ok: boolean;
  failedStep: number | null;
  stepCount: number;
  checkpoints: { step: number; file: string }[];
  steps: {
    index: number;
    action: string;
    ok: boolean;
    failures: string[];
    screenshot: string | null;
    /** The structured reading the step was judged against (route, cockpit mount, …). */
    reading?: { route?: string; cockpit?: { view?: string | null; focus?: string | null } } | null;
  }[];
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
const waitForFixtureProject = async (
  api: APIRequestContext,
  budgetMs = 30_000,
): Promise<{ projectId: string; hasQuayConfig: boolean }> => {
  const deadline = Date.now() + budgetMs;
  let last = 'never asked';
  while (Date.now() < deadline) {
    const response = await api.get('/api/projects');
    if (response.ok()) {
      const projects = (await response.json()) as {
        projectId?: string;
        fullPath?: string;
        path?: string;
        hasQuayConfig?: boolean;
      }[];
      const row = projects.find((project) => (project.fullPath ?? project.path) === WORKSPACE);
      if (row) {
        if (!row.hasQuayConfig) {
          throw new Error(`the fixture project was indexed without a quay config at ${WORKSPACE}`);
        }
        if (typeof row.projectId !== 'string') {
          throw new Error(`the fixture project row carries no projectId: ${JSON.stringify(row)}`);
        }
        return { projectId: row.projectId, hasQuayConfig: row.hasQuayConfig };
      }
      last = `GET /api/projects listed no project at ${WORKSPACE}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the fixture project never appeared after ${budgetMs}ms: ${last}`);
};

type RunnerRun = { status: number | null; stdout: string; stderr: string; report: RunnerReport | null };

/** The runner's argv, shared by the synchronous and asynchronous launchers. */
const runnerArgs = (scenarioFile: string, outDir: string, token: string, baseUrl: string): string[] => [
  RUNNER,
  scenarioFile,
  '--base-url', baseUrl,
  '--auth-token', token,
  '--project', WORKSPACE_NAME,
  '--session', SESSION_NAME,
  '--out', outDir,
];

/** Parses the report the runner prints on stdout; `null` when it printed none. */
const parseReport = (stdout: string): RunnerReport | null => {
  try {
    return JSON.parse(stdout) as RunnerReport;
  } catch {
    return null;
  }
};

/** Runs the runner and parses the report it printed on stdout. */
const runRunner = (scenarioFile: string, outDir: string, token: string, baseUrl = CLIENT_URL): RunnerRun => {
  const result = spawnSync(process.execPath, runnerArgs(scenarioFile, outDir, token, baseUrl), {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  return { status: result.status, stdout, stderr: result.stderr ?? '', report: parseReport(stdout) };
};

/**
 * Runs the runner WITHOUT blocking this process's event loop.
 *
 * The two cases below point the runner at an HTTP fixture served by THIS process, so a
 * `spawnSync` would deadlock: the child asks the fixture page for `/` and this process, blocked
 * inside `spawnSync`, never answers it. `runRunner` stays synchronous for the server-backed arms,
 * whose pages are served by the Vite webServer in another process.
 */
const runRunnerAsync = (
  scenarioFile: string,
  outDir: string,
  token: string,
  baseUrl: string,
): Promise<RunnerRun> => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, runnerArgs(scenarioFile, outDir, token, baseUrl), {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (status) => resolve({ status, stdout, stderr, report: parseReport(stdout) }));
});

/**
 * The app-shaped page the two runner cases below point at.
 *
 * It is deliberately not the real client. Both cases are about the RUNNER's own two failure
 * branches — picking a clickable element out of exact-text matches, and naming a missing semantic
 * surface — and the real sidebar cannot be made to render a zero-width decoy ahead of its row on
 * demand. The page reproduces the exact shapes those branches read:
 *
 *   · a zero-width span carrying the project name BEFORE the visible row that carries it too —
 *     the shape a flex-squeezed `truncate` display name produces in the real sidebar;
 *   · the session row, the cockpit mode switch, and the cockpit page's `data-testid`;
 *   · when `withSurface`, `window.__cloudcliScenario` returning the readings that
 *     `cockpit-mode-switch.json` asserts.
 */
const staticAppHtml = (pathname: string, withSurface: boolean): string => {
  const sessionPath = `/session/${SESSION_ID}`;
  const inCockpit = pathname.startsWith('/cockpit');
  const reading = `
      const route = location.pathname;
      const inCockpit = route.startsWith('/cockpit');
      return {
        route,
        activeView: inCockpit ? 'cockpit' : 'session',
        focus: null,
        focusLabel: null,
        lastInputPack: null,
        views: ['fixture'],
        cockpit: inCockpit
          ? { view: 'fleet', focus: null, focusLabel: null, echo: null, wallObjects: [] }
          : null,
      };`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>ui-scenario fixture</title></head>
<body>
  <aside>
    <span data-zero-width-project-name style="display:inline-block;width:0;height:0;overflow:hidden">${WORKSPACE_NAME}</span>
    <a href="${sessionPath}"><span class="truncate">${WORKSPACE_NAME}</span></a>
    <a href="${sessionPath}"><span class="truncate">${SESSION_NAME}</span></a>
    <a data-mode-switch-link="cockpit" href="/cockpit">cockpit</a>
    <a data-mode-switch-link="sessions" href="${sessionPath}">sessions</a>
  </aside>
  ${inCockpit ? '<main data-testid="cockpit-page">cockpit stage</main>' : `<main>${SESSION_NAME}</main>`}
  ${withSurface ? `<script>
    window.__cloudcliScenario = {
      read() {${reading}
      },
      drive() {},
    };
  </script>` : ''}
</body>
</html>
`;
};

type StaticApp = { url: string; close: () => Promise<void> };

/** Serves {@link staticAppHtml} from an ephemeral loopback port; every path gets the page. */
const startStaticApp = async (withSurface: boolean): Promise<StaticApp> => {
  const server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1');
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(staticAppHtml(pathname, withSurface));
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('the static fixture server did not bind a port');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
};

/**
 * Seeds the fixture project, signs in, waits for the app to index the project, and reads the one
 * capability the wall family needs: the fixture's quay-fleet REGISTRY id.
 *
 * A `null` fleet id is not a product failure — it is this host's registry not knowing a
 * throwaway fixture directory. The Quay panel deliberately mints no address in that case, so no
 * view contract is published and the wall scenario cannot be driven at all. The wall case turns
 * that into an explicit skip (with the command a developer can run to enable it) rather than a
 * 30-second runner timeout that says nothing.
 */
const prepareFixture = async (): Promise<{ token: string; fleetProjectId: string | null }> => {
  seedFixtureProject();
  const bootstrap = await request.newContext({ baseURL: CLIENT_URL });
  const token = await createAccount(bootstrap);
  await bootstrap.dispose();
  const api = await request.newContext({
    baseURL: CLIENT_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  try {
    const fixture = await waitForFixtureProject(api);
    const snapshot = await api.get(`/api/quay/${fixture.projectId}/snapshot`);
    const body = snapshot.ok() ? (await snapshot.json()) as { fleetProjectId?: string | null } : null;
    const fleetProjectId = typeof body?.fleetProjectId === 'string' ? body.fleetProjectId : null;
    return { token, fleetProjectId };
  } finally {
    await api.dispose();
  }
};

// Serial: both cases seed the same fixture project and sign in as the same account; running them
// in parallel would race the seed's symlink rewrite and the one-time registration.
test.describe.configure({ mode: 'serial' });

test.describe('the UI scenario runner on the Quay wall', () => {
  test('runs the wall scenario green, and names the failing step when an expectation is wrong', async () => {
    test.setTimeout(240_000);
    const { token, fleetProjectId } = await prepareFixture();
    test.skip(
      fleetProjectId === null,
      `this host's quay-fleet registry does not register the temporary fixture project at ${WORKSPACE}, `
      + 'so the Quay panel mints no address and publishes no view contract. Register it '
      + '(`quay-fleet registry add ui-scenario-workspace <that path>`) to run the wall family; '
      + 'the cockpit family below does not need a registry entry.',
    );

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

  test('runs the cockpit mode-switch scenario green, and names the failing step when an expectation is wrong', async () => {
    test.setTimeout(240_000);
    const { token } = await prepareFixture();

    fs.rmSync(COCKPIT_MAIN_OUT, { recursive: true, force: true });
    fs.rmSync(COCKPIT_CONTROL_OUT, { recursive: true, force: true });

    // ── main arm: session → cockpit → back to the same session ──────────────────────────────
    const main = runRunner(COCKPIT_SCENARIO_FILE, COCKPIT_MAIN_OUT, token);
    expect(main.status, `cockpit main arm must exit 0\nstdout=${main.stdout}\nstderr=${main.stderr}`).toBe(0);
    expect(main.report, `cockpit main arm must print a JSON report\nstdout=${main.stdout}\nstderr=${main.stderr}`).not.toBeNull();
    const mainReport = main.report as RunnerReport;

    expect(mainReport.ok, `cockpit main report must be ok: ${JSON.stringify(mainReport.steps)}`).toBe(true);
    expect(mainReport.failedStep).toBeNull();
    expect(mainReport.stepCount).toBe(3);
    expect(mainReport.steps.every((step) => step.ok), JSON.stringify(mainReport.steps)).toBe(true);
    // Every step is a checkpoint: the session it started from, the cockpit, the return trip.
    expect(mainReport.checkpoints.length).toBe(3);
    for (const checkpoint of mainReport.checkpoints) {
      expect(fs.existsSync(checkpoint.file), `checkpoint screenshot ${checkpoint.file} must exist`).toBe(true);
      expect(fs.statSync(checkpoint.file).size, `checkpoint screenshot ${checkpoint.file} must be non-empty`).toBeGreaterThan(0);
    }
    // THE RETURN IS THE PRODUCT'S OWN: step 3 must land on the exact session step 1 was reading,
    // not merely on some route under /session/.
    const startedAt = mainReport.steps[0]?.reading?.route;
    const returnedTo = mainReport.steps[2]?.reading?.route;
    expect(startedAt, `step 1 must read the session route: ${JSON.stringify(mainReport.steps[0])}`).toContain('/session/');
    expect(returnedTo, 'the cockpit must return to the session it was entered from').toBe(startedAt);

    // ── control arm: the SAME scenario, one expectation deliberately wrong ──────────────────
    const scenario = JSON.parse(fs.readFileSync(COCKPIT_SCENARIO_FILE, 'utf8')) as Scenario;
    const mutatedIndex = 1; // step 2: the cockpit stage IS mounted
    expect(scenario.steps[mutatedIndex]?.expect?.cockpitMounted, 'the control arm mutates the cockpit mount assertion').toBe(true);
    scenario.steps[mutatedIndex] = {
      ...scenario.steps[mutatedIndex],
      expect: { ...scenario.steps[mutatedIndex]?.expect, cockpitMounted: false },
    };
    scenario.name = 'cockpit-mode-switch-control';
    fs.mkdirSync(COCKPIT_CONTROL_OUT, { recursive: true });
    const controlScenario = path.join(COCKPIT_CONTROL_OUT, 'scenario.json');
    fs.writeFileSync(controlScenario, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');

    const control = runRunner(controlScenario, COCKPIT_CONTROL_OUT, token);
    expect(control.status, `cockpit control arm must exit non-zero\nstdout=${control.stdout}\nstderr=${control.stderr}`).toBe(1);
    expect(control.report, `cockpit control arm must still print a report\nstdout=${control.stdout}`).not.toBeNull();
    const controlReport = control.report as RunnerReport;

    expect(controlReport.ok).toBe(false);
    expect(controlReport.failedStep, 'the report must name the step that was mutated').toBe(mutatedIndex + 1);
    const failed = controlReport.steps[mutatedIndex];
    expect(failed?.ok, `step ${mutatedIndex + 1} must be the failed one: ${JSON.stringify(failed)}`).toBe(false);
    expect(failed?.failures.join('\n') ?? '', 'the failure must name the expectation it read').toContain('cockpitMounted');

    // The step before the mutation still passed, so the red is the mutated reading itself.
    expect(controlReport.steps[0]?.ok, `control step 1 must pass: ${JSON.stringify(controlReport.steps[0])}`).toBe(true);
  });
});

/**
 * The runner's two unusable-run branches, read against a page this spec serves itself.
 *
 * These cases do NOT measure the app: they measure what the runner does when the sidebar's DOM
 * shape is hostile (an exact-text span no click can land on) or when the page it was pointed at
 * cannot be driven at all (no semantic surface). Served from an ephemeral port in this process,
 * so the page is exactly what the case needs rather than whatever the shared fixture project
 * happens to render.
 */
test.describe('the UI scenario runner on a hostile or surface-less page', () => {
  test('skips a zero-width project-name span that precedes the visible row', async ({ page }) => {
    test.setTimeout(120_000);
    const app = await startStaticApp(true);
    try {
      // THE FIXTURE'S SHAPE IS PART OF THE READING: if the decoy were not really zero-width, or
      // did not come first, an unfiltered `.first()` would already hit the visible row and this
      // case would pass without exercising the fix at all.
      await page.goto(app.url);
      const decoy = page.locator('[data-zero-width-project-name]');
      await expect(decoy).toHaveCount(1);
      expect(
        await decoy.evaluate((element) => element.getBoundingClientRect().width),
        'the decoy project-name span must be zero-width, which is what makes Playwright call it invisible',
      ).toBe(0);
      await expect(decoy, 'Playwright must judge the zero-width decoy invisible').toBeHidden();
      const exactMatches = await page.evaluate((name) => {
        const spans = [...document.querySelectorAll('span')].filter((element) => element.textContent === name);
        return {
          count: spans.length,
          firstIsDecoy: spans[0]?.hasAttribute('data-zero-width-project-name') ?? false,
        };
      }, WORKSPACE_NAME);
      expect(exactMatches.count, 'the project name must match more than one element').toBeGreaterThanOrEqual(2);
      expect(exactMatches.firstIsDecoy, 'the zero-width decoy must come first in DOM order').toBe(true);

      fs.rmSync(ZERO_WIDTH_OUT, { recursive: true, force: true });
      const run = await runRunnerAsync(COCKPIT_SCENARIO_FILE, ZERO_WIDTH_OUT, 'fixture-token', app.url);
      expect(
        run.status,
        `the runner must reach the visible row and finish the cockpit scenario\nstdout=${run.stdout}\nstderr=${run.stderr}`,
      ).toBe(0);
      const report = run.report as RunnerReport;
      expect(report.ok, JSON.stringify(report.steps)).toBe(true);
      expect(report.failedStep).toBeNull();
      expect(report.stepCount).toBe(3);
      expect(report.steps.every((step) => step.ok), JSON.stringify(report.steps)).toBe(true);
      expect(report.checkpoints.length).toBe(3);
      for (const checkpoint of report.checkpoints) {
        expect(fs.existsSync(checkpoint.file), `checkpoint screenshot ${checkpoint.file} must exist`).toBe(true);
        expect(fs.statSync(checkpoint.file).size, `checkpoint screenshot ${checkpoint.file} must be non-empty`).toBeGreaterThan(0);
      }
    } finally {
      await app.close();
    }
  });

  test('names why the run is unusable when the page comes without the semantic surface', async () => {
    test.setTimeout(120_000);
    const app = await startStaticApp(false);
    try {
      fs.rmSync(NO_SURFACE_OUT, { recursive: true, force: true });
      const startedAt = Date.now();
      const run = await runRunnerAsync(COCKPIT_SCENARIO_FILE, NO_SURFACE_OUT, 'fixture-token', app.url);
      const elapsedMs = Date.now() - startedAt;

      expect(
        run.status,
        `a page with no semantic surface is an unusable run (exit 2)\nstdout=${run.stdout}\nstderr=${run.stderr}`,
      ).toBe(2);
      expect(run.report, 'an unusable run prints no report').toBeNull();
      expect(run.stderr, 'the error must name WHAT was missing, not just that a wait timed out').toContain('semantic surface');
      expect(
        elapsedMs,
        'the run must end on its boot budget rather than hang — budget plus browser launch and navigation',
      ).toBeLessThan(BOOT_TIMEOUT_MS + 15_000);
    } finally {
      await app.close();
    }
  });
});
