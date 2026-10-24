#!/usr/bin/env node
/**
 * The UI scenario runner: one browser page, a whole business scenario, one JSON report.
 *
 * WHY IT EXISTS. Driving a 15–20-step scenario through an MCP browser costs a round trip per
 * step — and usually a multi-thousand-token snapshot — while the state the scenario asserts
 * (focus, the visible set, the tray, the input pack, per-step latency) is mostly NOT in the DOM.
 * This runner opens the page once, turns on the dev-only semantic surface
 * (`window.__cloudcliScenario`), and drives/reads the scenario through it. Between checkpoints a
 * contiguous run of steps executes in ONE in-page call, so the round-trip count is the number of
 * checkpoints plus one, not the number of steps.
 *
 * WHAT THE SCENARIO IS. A JSON file with a `name` and `steps`; each step may carry:
 *   · `open`: an opener name — reaching a view is navigation, not business state, so it is the
 *     only step that touches the DOM. The vocabulary is explicit and closed:
 *       `quay-panel` — a project's Quay view (sidebar project → session → Quay tab);
 *       `session`    — one session's workspace (the sidebar project → session rows);
 *       `cockpit`    — the cockpit stage, entered through the same mode switch a person uses, so
 *                      the return path a later `session` step lands on is the product's own.
 *     An unknown opener fails its step rather than being ignored.
 *   · `drive`: one {@link ScenarioDriveStep} for `window.__cloudcliScenario.drive`.
 *   · `expect`: a map of reading assertions, evaluated after the step (see
 *     {@link expectationFailures}); an unsupported key is a failure, never a silent pass.
 *   · `checkpoint`: take a full-page screenshot after this step.
 *
 * OUTPUT. A JSON report on STDOUT and nothing else (diagnostics go to stderr), plus
 * `report.json` and the checkpoint PNGs under `--out`. Exit 0 = every step passed, 1 = a step
 * failed (`failedStep` is its 1-based number), 2 = the run could not be attempted.
 *
 * USAGE.
 *   node scripts/ui-scenario.mjs <scenario.json> --base-url http://127.0.0.1:5173 \
 *     --auth-token <token> --project <workspace-name> --session <session-name> [--out <dir>]
 */

import fs from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright';

/** Exit codes: a failed expectation is 1; a run that never started is 2. */
const EXIT_FAILED = 1;
const EXIT_UNUSABLE = 2;

/** How long one page-level wait may take before the run is called unusable. */
const BOOT_TIMEOUT_MS = 30_000;
/** How long the Quay panel's loaded reading may take after the tab is clicked. */
const PANEL_TIMEOUT_MS = 30_000;

/**
 * @typedef {{
 *   open?: string,
 *   drive?: Record<string, unknown>,
 *   expect?: Record<string, unknown>,
 *   checkpoint?: boolean,
 * }} ScenarioStep
 */

/**
 * @typedef {{
 *   name?: string,
 *   description?: string,
 *   steps: ScenarioStep[],
 * }} Scenario
 */

/**
 * @typedef {{
 *   index: number,
 *   action: string,
 *   ok: boolean,
 *   failures: string[],
 *   checkpoint: boolean,
 *   screenshot: string | null,
 *   reading: unknown,
 * }} StepResult
 */

/** Prints a usage error and returns the unusable exit code.
 * @param {string} message
 */
function usage(message) {
  process.stderr.write(`ui-scenario: ${message}\n`);
  process.stderr.write(
    'usage: node scripts/ui-scenario.mjs <scenario.json> --base-url <url> --auth-token <token>'
    + ' --project <name> --session <name> [--out <dir>]\n',
  );
  return EXIT_UNUSABLE;
}

/** Parses `--flag value` pairs into a map; a flag with no value is a usage error.
 * @param {string[]} argv
 */
function parseFlags(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith('--')) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`flag ${arg} needs a value`);
    }
    flags[arg.slice(2)] = value;
    i += 1;
  }
  return flags;
}

/** Reads and shape-checks one scenario file.
 * @param {string} file
 */
function readScenario(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.steps)) {
    throw new Error(`${file}: a scenario must be an object with a steps array`);
  }
  if (parsed.steps.length === 0) {
    throw new Error(`${file}: a scenario must have at least one step`);
  }
  return /** @type {Scenario} */ (parsed);
}

/** The action name a report shows for one step.
 * @param {ScenarioStep} step
 */
function stepAction(step) {
  if (typeof step.open === 'string') return `open:${step.open}`;
  if (step.drive !== undefined) return `drive:${Object.keys(step.drive)[0] ?? 'unknown'}`;
  return 'expect';
}

/** Deep equality for the small JSON values a scenario asserts (labels, counts, strings).
 * @param {unknown} a
 * @param {unknown} b
 */
function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Evaluates one step's `expect` map against one reading.
 *
 * EVERY KEY IS NAMED HERE. An unknown key fails the step: a typo in a scenario must not be
 * indistinguishable from an assertion that happened to hold — the control arm of this runner's
 * own criterion depends on a wrong expectation being observable.
 *
 * @param {Record<string, unknown>} expect
 * @param {any} reading
 * @returns {string[]} one sentence per failed assertion (empty when every one held)
 */
function expectationFailures(expect, reading) {
  /** @type {string[]} */
  const failures = [];
  /** @type {(key: string, expected: unknown, actual: unknown) => void} */
  const fail = (key, expected, actual) => {
    failures.push(`${key}: expected ${JSON.stringify(expected)}, read ${JSON.stringify(actual)}`);
  };

  for (const [key, expected] of Object.entries(expect)) {
    switch (key) {
      case 'routeIncludes': {
        const actual = typeof reading.route === 'string' ? reading.route : null;
        if (actual === null || !actual.includes(String(expected))) fail(key, expected, actual);
        break;
      }
      case 'activeViewIncludes': {
        const actual = typeof reading.activeView === 'string' ? reading.activeView : null;
        if (actual === null || !actual.includes(String(expected))) fail(key, expected, actual);
        break;
      }
      case 'cockpitViewIs': {
        // `null` is a real assertion (the cockpit is not mounted); it is not "skip".
        const actual = reading.cockpit?.view ?? null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'cockpitMounted': {
        // Which view the mode switch opens depends on whether the selected project is registered
        // with quay-fleet (board) or not (fleet). A scenario about the switch itself asserts the
        // stage is mounted, not which of the two legitimate views it chose.
        const actual = typeof reading.cockpit?.view === 'string';
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'cockpitFocusIs': {
        const actual = reading.cockpit?.focus ?? null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'cockpitFocusLabel': {
        const actual = reading.cockpit?.focusLabel ?? null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'cockpitEchoIs': {
        const actual = reading.cockpit?.echo ?? null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'wallObjectCount': {
        const actual = Array.isArray(reading.cockpit?.wallObjects)
          ? reading.cockpit.wallObjects.length
          : null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'wallObjectLabels': {
        const actual = Array.isArray(reading.cockpit?.wallObjects)
          ? reading.cockpit.wallObjects.map((/** @type {any} */ object) => object.label)
          : null;
        if (!sameJson(actual, expected)) fail(key, expected, actual);
        break;
      }
      case 'focusableCount': {
        const actual = Array.isArray(reading.focusables) ? reading.focusables.length : null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'focusableLabels': {
        const actual = Array.isArray(reading.focusables)
          ? reading.focusables.map((/** @type {any} */ object) => object.label)
          : null;
        if (!sameJson(actual, expected)) fail(key, expected, actual);
        break;
      }
      case 'focusLabel': {
        if (reading.focusLabel !== expected) fail(key, expected, reading.focusLabel);
        break;
      }
      case 'focusUriIncludes': {
        const actual = typeof reading.focus === 'string' ? reading.focus : null;
        if (actual === null || !actual.includes(String(expected))) fail(key, expected, actual);
        break;
      }
      case 'trayCount': {
        const actual = Array.isArray(reading.tray) ? reading.tray.length : null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'trayHasFocus': {
        const actual = typeof reading.focus === 'string'
          && Array.isArray(reading.tray)
          && reading.tray.includes(reading.focus);
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'lastInputPackFocusLabel': {
        const actual = reading.lastInputPack === null ? null : reading.lastInputPack.focusLabel;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'lastInputPackUtterance': {
        const actual = reading.lastInputPack === null ? null : reading.lastInputPack.utterance;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'lastInputPackTrayCount': {
        const actual = reading.lastInputPack === null ? null : reading.lastInputPack.tray.length;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'lastInputPackSeamBuilds': {
        const actual = reading.lastInputPack === null ? null : reading.lastInputPack.seamBuilds;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'lastInputPackFocusIsCurrent': {
        const actual = reading.lastInputPack !== null
          && reading.lastInputPack.focus === reading.focus;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      default:
        failures.push(`${key}: unsupported expectation key (a scenario typo must not pass silently)`);
    }
  }
  return failures;
}

/**
 * Waits for the app's semantic surface to be installed.
 *
 * The surface is attached by a dynamic import in `main.tsx`, so the first document can paint
 * before it exists. `globalThis` rather than `window` because this module is typechecked under
 * Node's lib only (the callback runs in the page, but its source is checked here).
 *
 * @param {import('playwright').Page} page
 */
async function waitForSurface(page) {
  await page.waitForFunction(
    () => Boolean(/** @type {any} */ (globalThis).__cloudcliScenario),
    undefined,
    { timeout: BOOT_TIMEOUT_MS },
  );
}

/** Reads the surface's structured state in one round trip.
 * @param {import('playwright').Page} page
 */
async function readSurface(page) {
  return page.evaluate(() => /** @type {any} */ (globalThis).__cloudcliScenario.read());
}

/**
 * Waits until at least one view has published its contract.
 *
 * The panel renders before its publish effect's dynamic import resolves, so a read taken the
 * instant the panel is visible can see an empty registry. Waiting for the publication — not for a
 * non-empty focusable list — keeps a legitimately empty view readable.
 *
 * @param {import('playwright').Page} page
 */
async function waitForPublishedView(page) {
  await page.waitForFunction(
    () => {
      const surface = /** @type {any} */ (globalThis).__cloudcliScenario;
      return Boolean(surface) && surface.read().views.length > 0;
    },
    undefined,
    { timeout: PANEL_TIMEOUT_MS },
  );
}

/**
 * Selects one project and then one of its sessions from the sidebar, from a freshly loaded `/`.
 *
 * Shared by every opener that lands on a session: the Quay view starts from the same selection
 * before it clicks its tab, and the session opener stops here. The Vite dependency optimizer can
 * reload the document mid-navigation (a `504 Outdated Optimize Dep` on a first boot), so the first
 * paint is probed with bounded reloads rather than left to a locator that waits on a document that
 * no longer exists.
 *
 * @param {import('playwright').Page} page
 * @param {{ project: string, session: string }} target
 */
async function selectProjectSession(page, target) {
  const projectRow = page.getByText(target.project, { exact: true }).first();
  const sessionRow = page.getByText(target.session, { exact: true }).first();

  await page.goto('/');
  /** @param {number} timeout */
  const appears = (timeout) => projectRow.waitFor({ state: 'visible', timeout }).then(() => true, () => false);
  let up = await appears(10_000);
  for (let attempt = 0; !up && attempt < 2; attempt += 1) {
    await page.reload().catch(() => undefined);
    up = await appears(6_000);
  }
  if (!up) {
    throw new Error(`the fixture project "${target.project}" never appeared in the sidebar`);
  }

  await projectRow.click();
  await sessionRow.waitFor({ state: 'visible', timeout: 10_000 });
  await sessionRow.click();
}

/** True when the page's path is a session workspace route. */
const SESSION_ROUTE = /\/session\/[^/]+/;

/**
 * Opens one session's workspace.
 *
 * TWO WAYS IN, ONE READING. From a cold page this is the sidebar selection a person makes. From
 * the cockpit it is the mode switch's 「会话」 segment, which lands on the route the cockpit
 * recorded when it was entered — the product's own return path, not a URL the runner invents.
 * The cold fallback keeps the opener usable when no route was recorded (a scenario that opens
 * `session` first).
 *
 * @param {import('playwright').Page} page
 * @param {{ project: string, session: string }} target
 */
async function openSession(page, target) {
  const onCockpit = await page.getByTestId('cockpit-page').isVisible().catch(() => false);
  if (onCockpit) {
    const sessionsLink = page.locator('[data-mode-switch-link="sessions"]').first();
    await sessionsLink.waitFor({ state: 'visible', timeout: 10_000 });
    await sessionsLink.click();
    // The remembered route may be a session (the usual case) or `/` when there was none; wait
    // for the cockpit to unmount before deciding which one it was.
    await page.waitForFunction(
      // `globalThis`, not `window`: this module is typechecked under Node's lib only, and the
      // callback runs in the page.
      () => !(/** @type {any} */ (globalThis)).location.pathname.startsWith('/cockpit'),
      undefined,
      { timeout: BOOT_TIMEOUT_MS },
    );
    const returned = await page
      .waitForURL((url) => SESSION_ROUTE.test(url.pathname), { timeout: 5_000 })
      .then(() => true, () => false);
    if (!returned) {
      await selectProjectSession(page, target);
    }
  } else {
    await selectProjectSession(page, target);
  }
  await page.waitForURL((url) => SESSION_ROUTE.test(url.pathname), { timeout: BOOT_TIMEOUT_MS });
  await waitForSurface(page);
}

/**
 * Opens the cockpit stage through the same mode switch a person uses.
 *
 * WHY THE SWITCH AND NOT A DIRECT NAVIGATION: the switch is what records the pre-cockpit route in
 * session storage, and that record is what a later `session` step returns to. A `page.goto('/cockpit')`
 * would open the same stage but leave the return path empty, so the round trip a scenario asserts
 * would not be the one the product performs.
 *
 * @param {import('playwright').Page} page
 */
async function openCockpit(page) {
  if (!page.url().startsWith('http')) {
    await page.goto('/');
  }
  await waitForSurface(page);
  const cockpitLink = page.locator('[data-mode-switch-link="cockpit"]').first();
  await cockpitLink.waitFor({ state: 'visible', timeout: BOOT_TIMEOUT_MS });
  await cockpitLink.click();
  await page.waitForURL((url) => url.pathname.startsWith('/cockpit'), {
    timeout: BOOT_TIMEOUT_MS,
  });
  await page.locator('[data-testid="cockpit-page"]').first().waitFor({
    state: 'visible',
    timeout: PANEL_TIMEOUT_MS,
  });
}

/**
 * Navigates the app to one project's Quay view.
 *
 * THE PROJECT IS SELECTED FROM THE SIDEBAR rather than deep-linked: a session-URL landing can
 * synthesize a project row before the project list loads, and that synthesized row carries no
 * `hasQuayConfig`, so it offers no Quay view.
 *
 * @param {import('playwright').Page} page
 * @param {{ project: string, session: string }} target
 */
async function openQuayPanel(page, target) {
  await selectProjectSession(page, target);

  const tab = page.locator('[data-workspace-tab="quay"]').first();
  const tabVisible = await tab.isVisible().catch(() => false);
  if (tabVisible) {
    await tab.click();
  } else {
    // Compact layouts (a phone) put the tablist behind the header's selector dialog.
    const selector = page.locator('header [aria-haspopup="dialog"]').first();
    await selector.waitFor({ state: 'visible', timeout: 10_000 });
    await selector.click();
    const dialogTab = page.getByRole('dialog').locator('[data-workspace-tab="quay"]').first();
    await dialogTab.waitFor({ state: 'visible', timeout: 10_000 });
    await dialogTab.click();
  }

  await page.locator('[data-testid="quay-panel-loaded"]').waitFor({ state: 'visible', timeout: PANEL_TIMEOUT_MS });
  await waitForPublishedView(page);
}

/**
 * Runs one scenario file and returns its report.
 *
 * @param {import('playwright').Browser} browser
 * @param {Scenario} scenario
 * @param {{
 *   baseUrl: string,
 *   authToken: string,
 *   project: string,
 *   session: string,
 *   outDir: string,
 *   scenarioFile: string,
 * }} options
 * @returns {Promise<{ report: any, ok: boolean }>}
 */
async function runScenario(browser, scenario, options) {
  const startedAt = Date.now();
  const context = await browser.newContext({
    baseURL: options.baseUrl,
    viewport: { width: 1280, height: 800 },
  });
  await context.addInitScript(
    ({ token }) => {
      // The runtime lock: `localStorage['ui-scenario']='on'` is the operator-visible half of the
      // two-lock gate (the other is the build-time `import.meta.env.DEV` in `main.tsx`).
      // The cast is because this module is typechecked under Node's lib only; the callback runs
      // in the page, where these globals exist.
      const storage = /** @type {any} */ (globalThis).localStorage;
      storage.setItem('ui-scenario', 'on');
      storage.setItem('auth-token', token);
      storage.setItem('userLanguage', 'en');
    },
    { token: options.authToken },
  );

  const page = await context.newPage();
  /** @type {StepResult[]} */
  const results = [];
  /** @type {{ step: ScenarioStep, index: number }[]} */
  let batch = [];

  /**
   * Runs the accumulated in-page steps in ONE evaluate and records their results.
   *
   * Checkpoints end a batch: a screenshot has to happen between steps, so a batch never spans
   * one. This is what keeps the run's round trips proportional to checkpoints, not steps.
   */
  const flushBatch = async () => {
    if (batch.length === 0) return;
    const readings = await page.evaluate((steps) => {
      const surface = /** @type {any} */ (globalThis).__cloudcliScenario;
      return steps.map((step) => {
        if (step.drive !== undefined) {
          surface.drive(step.drive);
        }
        return surface.read();
      });
    }, batch.map((entry) => entry.step));

    for (let i = 0; i < batch.length; i += 1) {
      const entry = batch[i];
      const step = entry.step;
      const reading = readings[i];
      const checkpoint = step.checkpoint === true;
      let screenshot = null;
      if (checkpoint) {
        const file = path.join(options.outDir, `step-${entry.index + 1}-${stepAction(step).replace(/[:/]/g, '-')}.png`);
        await page.screenshot({ path: file, fullPage: true });
        screenshot = file;
      }
      const failures = expectationFailures(step.expect ?? {}, reading);
      results.push({
        index: entry.index + 1,
        action: stepAction(step),
        ok: failures.length === 0,
        failures,
        checkpoint,
        screenshot,
        reading,
      });
    }
    batch = [];
  };

  /** True once a document of the app is loaded with the surface installed. */
  let appReady = false;

  try {
    for (let index = 0; index < scenario.steps.length; index += 1) {
      const step = scenario.steps[index];
      if (!appReady && step.open === undefined) {
        // A scenario that never opens a view still needs the app under it.
        await page.goto('/');
        await waitForSurface(page);
        appReady = true;
      }
      if (step.open !== undefined) {
        await flushBatch();
        /** @type {Record<string, (() => Promise<void>) | undefined>} */
        const openers = {
          'quay-panel': () => openQuayPanel(page, { project: options.project, session: options.session }),
          session: () => openSession(page, { project: options.project, session: options.session }),
          cockpit: () => openCockpit(page),
        };
        const execute = openers[step.open];
        if (execute === undefined) {
          const failures = [`unsupported opener ${JSON.stringify(step.open)}`];
          results.push({
            index: index + 1,
            action: stepAction(step),
            ok: false,
            failures,
            checkpoint: step.checkpoint === true,
            screenshot: null,
            reading: null,
          });
          continue;
        }
        await execute();
        appReady = true;
        const reading = await readSurface(page);
        let screenshot = null;
        if (step.checkpoint === true) {
          const file = path.join(options.outDir, `step-${index + 1}-${stepAction(step).replace(/[:/]/g, '-')}.png`);
          await page.screenshot({ path: file, fullPage: true });
          screenshot = file;
        }
        const failures = expectationFailures(step.expect ?? {}, reading);
        results.push({
          index: index + 1,
          action: stepAction(step),
          ok: failures.length === 0,
          failures,
          checkpoint: step.checkpoint === true,
          screenshot,
          reading,
        });
        continue;
      }

      batch.push({ step, index });
      if (step.checkpoint === true) {
        await flushBatch();
      }
    }
    await flushBatch();
  } finally {
    await context.close();
  }

  const failed = results.find((result) => !result.ok) ?? null;
  const report = {
    scenario: scenario.name ?? path.basename(options.scenarioFile, '.json'),
    description: scenario.description ?? null,
    baseUrl: options.baseUrl,
    ok: failed === null,
    failedStep: failed === null ? null : failed.index,
    stepCount: results.length,
    durationMs: Date.now() - startedAt,
    checkpoints: results
      .filter((result) => result.screenshot !== null)
      .map((result) => ({ step: result.index, file: result.screenshot })),
    steps: results.map((result) => ({
      index: result.index,
      action: result.action,
      ok: result.ok,
      failures: result.failures,
      checkpoint: result.checkpoint,
      screenshot: result.screenshot,
      reading: result.reading,
    })),
  };
  fs.writeFileSync(path.join(options.outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { report, ok: failed === null };
}

/** The CLI entry point. */
async function main() {
  const argv = process.argv.slice(2);
  const scenarioFile = argv[0];
  if (scenarioFile === undefined || scenarioFile.startsWith('--')) {
    return usage('a scenario file is required');
  }

  /** @type {Record<string, string>} */
  let flags;
  try {
    flags = parseFlags(argv.slice(1));
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }

  const baseUrl = flags['base-url'];
  const authToken = flags['auth-token'];
  const project = flags.project;
  const session = flags.session;
  for (const [name, value] of Object.entries({ 'base-url': baseUrl, 'auth-token': authToken, project, session })) {
    if (value === undefined || value === '') {
      return usage(`--${name} is required`);
    }
  }

  let scenario;
  try {
    scenario = readScenario(scenarioFile);
  } catch (error) {
    process.stderr.write(`ui-scenario: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_UNUSABLE;
  }

  const outDir = path.resolve(flags.out ?? path.join('tmp', 'ui-scenarios', scenario.name ?? path.basename(scenarioFile, '.json')));
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const { report, ok } = await runScenario(browser, scenario, {
      baseUrl: baseUrl ?? '',
      authToken: authToken ?? '',
      project: project ?? '',
      session: session ?? '',
      outDir,
      scenarioFile,
    });
    // The report is the program's output; a failing step is still a complete report.
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(
      `ui-scenario: ${report.ok ? 'passed' : `FAILED at step ${report.failedStep}`}`
      + ` (${report.stepCount} steps, ${report.durationMs}ms, ${report.checkpoints.length} checkpoint(s))\n`,
    );
    return ok ? 0 : EXIT_FAILED;
  } catch (error) {
    process.stderr.write(`ui-scenario: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    return EXIT_UNUSABLE;
  } finally {
    await browser.close();
  }
}

process.exitCode = await main();
