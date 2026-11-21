#!/usr/bin/env node
/**
 * The UI scenario runner: one browser page, a whole business scenario, one JSON report.
 *
 * WHY IT EXISTS. Driving a 15–20-step scenario through an MCP browser costs a round trip per
 * step — and usually a multi-thousand-token snapshot — while the state the scenario asserts
 * (focus, the visible set, the tray, the input pack, per-step latency) is mostly NOT in the DOM.
 * This runner opens the page once, turns on the dev-only semantic surface
 * (`window.__cloudpitScenario`), and drives/reads the scenario through it. Between checkpoints a
 * contiguous run of steps executes in ONE in-page call, so the round-trip count is the number of
 * checkpoints plus one, not the number of steps.
 *
 * WHAT THE SCENARIO IS. A JSON file with a `name` and `steps`; each step may carry:
 *   · `open`: an opener name — reaching a view is navigation, not business state, so it is the
 *     only step that touches the DOM. An opener may name its own `project`/`session`, which is
 *     how one scenario switches between two sessions. The vocabulary is explicit and closed:
 *       `quay-panel` — a project's Quay view (sidebar project → session → Quay tab);
 *       `session`    — one session's workspace (the sidebar project → session rows);
 *       `cockpit`    — the cockpit stage, entered through the same mode switch a person uses, so
 *                      the return path a later `session` step lands on is the product's own;
 *       `cockpit-cards` — the cockpit's cards view: the same mode-switch entry, then the stage's
 *                      own `?view=cards` address (the app draws no separate cards link).
 *       `settings`   — the Settings dialog's Cockpit tab, opened from the sidebar's Settings
 *                      button; the opener waits until the form's own reading is `ready`/`failed`,
 *                      so the first step never catches it mid-load.
 *       `settings-agents-codex` — Settings → Agents → Codex → Models: the project provider
 *                      registry with the bound model library and the user-profile import
 *                      panel; waits until BOTH the registry's and the import panel's own
 *                      statuses settle (`ready`/`failed`).
 *       `quay-pulse` — the title-bar Loop pulse popover of the session the page is already on;
 *                      the opener presses the trigger and waits for the mention list to settle,
 *                      because that list arrives over the network after the popover mounts.
 *       `cost-panel` — the `/cost` modal, opened by typing the command into the composer and
 *                      picking the menu's own row; it waits for the panel to declare itself
 *                      mounted, so the first reading is a drawn panel, not a command in flight.
 *     An unknown opener fails its step rather than being ignored.
 *   · `reload`: reload the current page and wait for the surface again. The refresh leg of a
 *     continuity scenario is a real browser reload, not a re-navigation through the sidebar.
 *     With `waitForChat: true` it also waits until the reloaded page has drawn non-empty
 *     transcript rows, because a session route fetches its history after the surface mounts.
 *     `waitForCards: true` does the same for the cockpit cards view's visible set.
 *   · `drive`: one {@link ScenarioDriveStep} for `window.__cloudpitScenario.drive`.
 *   · `waitFor`: a page-state wait, readable when the state is produced by an async answer that
 *     a synchronous `drive` cannot observe. Currently `draftRewrite:<chip|loading|candidate|error>`.
 *     `timeoutMs` bounds it (default the boot budget).
 *   · `debugLog`: a NODE-SIDE step against the reply-suggestions debug ledger, because the
 *     ledger is a server file the page cannot read. `{ set?: boolean, rewrite?: string }` writes
 *     the opt-in switch (`PUT /debug-log`) and/or performs one real `POST /draft-rewrite`
 *     through Playwright's request context (which BYPASSES the page's `--mock-gateway` route, so
 *     the server actually records the attempt). Every reading carries `debugLogLines`, and
 *     `debugLogLinesIs` / `debugLogLinesDeltaIs` assert the file's line count (the latter
 *     against the previous step's reading). `--debug-log-file` overrides the path.
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
 *     [--viewport 1280x800] [--mock-gateway <responses.json>] [--debug-log-file <path>]
 *
 * `--mock-gateway` installs a LOCAL route for `POST /api/reply-suggestions/draft-rewrite` and
 * answers from the JSON file's `responses` array, one per request in order (the last entry is
 * reused after that). Each entry is `{ status?, body?, delayMs? }`. This is a local injection:
 * the report says so, and nothing it produces is evidence about real model quality. The request
 * count is reported (`mockGateway.requests`) and readable as the `draftRewriteRequestsIs`
 * expectation, so a re-open that spends a second request is observable.
 */

import fs from 'node:fs';
import os from 'node:os';
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
 *   project?: string,
 *   session?: string,
 *   reload?: boolean,
 *   waitForChat?: boolean,
 *   waitForCards?: boolean,
 *   drive?: Record<string, unknown>,
 *   waitFor?: string,
 *   timeoutMs?: number,
 *   debugLog?: { set?: boolean, rewrite?: string, sessionId?: string },
 *   expect?: Record<string, unknown>,
 *   checkpoint?: boolean,
 * }} ScenarioStep
 */

/**
 * @typedef {{
 *   name?: string,
 *   description?: string,
 *   mockGateway?: { responses: unknown[] },
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
  if (step.reload === true) return 'reload';
  if (step.debugLog !== undefined) {
    if (step.debugLog.set !== undefined) return `debugLog:set:${String(step.debugLog.set)}`;
    return 'debugLog:rewrite';
  }
  if (step.drive !== undefined) return `drive:${Object.keys(step.drive)[0] ?? 'unknown'}`;
  if (typeof step.waitFor === 'string') return `waitFor:${step.waitFor}`;
  return 'expect';
}

/**
 * The reply-suggestions debug ledger's line count, read from the SERVER's local file.
 *
 * The page cannot see the server's home, so this reading is taken here. A missing file is
 * 0 lines (the shipped default), never an error.
 * @param {string} filePath
 * @returns {number}
 */
function countDebugLogLines(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return text.split('\n').filter((line) => line !== '').length;
  } catch {
    return 0;
  }
}

/**
 * One card from the cockpit's cards reading, or `null` when that card is not visible.
 *
 * The card assertions below all name a card id rather than an index: the visible order changes
 * with the filters, and an index would silently assert about a different card.
 *
 * @param {any} reading
 * @param {string} cardId
 * @returns {any | null}
 */
function cardReading(reading, cardId) {
  const cards = reading?.cockpit?.cards ?? null;
  if (cards === null || !Array.isArray(cards.cards)) return null;
  return cards.cards.find((/** @type {any} */ card) => card.id === cardId) ?? null;
}

/**
 * True when `value` is a non-null, non-array object — the shape the card keys take.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
 * @param {number | null} [previousDebugLogLines]
 * @returns {string[]} one sentence per failed assertion (empty when every one held)
 */
function expectationFailures(expect, reading, previousDebugLogLines = null) {
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
      case 'cockpitCardsVisible': {
        // The visible ids IN ORDER: a filter that reorders or hides a card must be observable.
        const actual = Array.isArray(reading.cockpit?.cards?.visibleCardIds)
          ? reading.cockpit.cards.visibleCardIds
          : null;
        if (!Array.isArray(expected) || !sameJson(actual, expected)) fail(key, expected, actual);
        break;
      }
      case 'cockpitCardSelected': {
        const actual = reading.cockpit?.cards?.selectedCardId ?? null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'cockpitCardDetailsOpen': {
        // The card whose Details drawer is mounted, or `null` when it is closed. Taken from the
        // list's own declaration, so a drawer that closed after its card left reads as `null`.
        const actual = reading.cockpit?.cards?.detailsOpenCardId ?? null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'cockpitCardDismissOpen': {
        // The card whose 「忽略/丢弃」 confirmation is open, or `null`. The SAME reading is drawn
        // by the card row's bar and the Details drawer's bar, so a scenario can prove the drawer's
        // first press opened the confirmation rather than inferring it from a label.
        const actual = typeof reading.cockpit?.cards?.dismissOpenCardId === 'string'
          ? reading.cockpit.cards.dismissOpenCardId
          : null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'cockpitCardShownOption': {
        // `{ cardId, optionId }` — the option one card currently shows (`null` when none).
        if (!isRecord(expected) || typeof expected.cardId !== 'string') {
          failures.push(`${key}: expected { cardId, optionId }`);
          break;
        }
        const card = cardReading(reading, expected.cardId);
        const actual = card === null ? null : card.shownOptionId ?? null;
        const wanted = expected.optionId ?? null;
        if (actual !== wanted) fail(key, wanted, actual);
        break;
      }
      case 'cockpitCardConfirmTarget': {
        // `{ cardId, optionId, label? }` — what one card's confirm bar would send. A card with
        // no recommendation has no target, which is `{ optionId: null, label: null }`.
        if (!isRecord(expected) || typeof expected.cardId !== 'string') {
          failures.push(`${key}: expected { cardId, optionId, label? }`);
          break;
        }
        const card = cardReading(reading, expected.cardId);
        const compareLabel = expected.label !== undefined;
        const actual = card === null
          ? null
          : {
              optionId: card.confirmOptionId ?? null,
              ...(compareLabel ? { label: card.confirmLabel ?? null } : {}),
            };
        const wanted = {
          optionId: expected.optionId ?? null,
          ...(compareLabel ? { label: expected.label ?? null } : {}),
        };
        if (!sameJson(actual, wanted)) fail(key, wanted, actual);
        break;
      }
      case 'cockpitCardKnowledgeState': {
        // `{ cardId, state }` — the provider's knowledge case state for one card (`null` when the
        // card asks no knowledge decision, or the card is not drawn).
        if (!isRecord(expected) || typeof expected.cardId !== 'string') {
          failures.push(`${key}: expected { cardId, state }`);
          break;
        }
        const card = cardReading(reading, expected.cardId);
        const actual = card === null ? null : card.knowledgeState ?? null;
        const wanted = expected.state ?? null;
        if (actual !== wanted) fail(key, wanted, actual);
        break;
      }
      case 'cockpitCardKnowledgeVerification': {
        // `{ cardId, state }` — the provider's verification verdict, never the cockpit's guess.
        if (!isRecord(expected) || typeof expected.cardId !== 'string') {
          failures.push(`${key}: expected { cardId, state }`);
          break;
        }
        const card = cardReading(reading, expected.cardId);
        const actual = card === null ? null : card.knowledgeVerificationState ?? null;
        const wanted = expected.state ?? null;
        if (actual !== wanted) fail(key, wanted, actual);
        break;
      }
      case 'cockpitCardKnowledgeStates': {
        // `{ cardId: state }` — the same reading for several cards at once, so one step can
        // state a whole board's knowledge states without repeating a key.
        if (!isRecord(expected)) {
          failures.push(`${key}: expected { cardId: state }`);
          break;
        }
        for (const [cardId, wanted] of Object.entries(expected)) {
          const card = cardReading(reading, cardId);
          const actual = card === null ? null : card.knowledgeState ?? null;
          if (actual !== (wanted ?? null)) fail(`${key}.${cardId}`, wanted ?? null, actual);
        }
        break;
      }
      case 'cockpitCardKnowledgeVerifications': {
        // `{ cardId: state }` — the provider's verification verdicts, never the cockpit's guess.
        if (!isRecord(expected)) {
          failures.push(`${key}: expected { cardId: state }`);
          break;
        }
        for (const [cardId, wanted] of Object.entries(expected)) {
          const card = cardReading(reading, cardId);
          const actual = card === null ? null : card.knowledgeVerificationState ?? null;
          if (actual !== (wanted ?? null)) fail(`${key}.${cardId}`, wanted ?? null, actual);
        }
        break;
      }
      case 'quayPulseOpen': {
        const actual = reading.quayPulse?.open ?? null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'quayPulseTranscriptState': {
        const actual = reading.quayPulse?.transcript ?? null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'quayPulseTaskIds': {
        // The ids IN ORDER: a reading that loses one session's mentions or gains another's
        // must be observable, not merely present.
        const actual = Array.isArray(reading.quayPulse?.taskIds) ? reading.quayPulse.taskIds : null;
        if (!Array.isArray(expected) || !sameJson(actual, expected)) fail(key, expected, actual);
        break;
      }
      case 'quayPulseGoalIds': {
        const actual = Array.isArray(reading.quayPulse?.goalIds) ? reading.quayPulse.goalIds : null;
        if (!Array.isArray(expected) || !sameJson(actual, expected)) fail(key, expected, actual);
        break;
      }
      case 'costPanelOpen': {
        // `null` is a real reading (the panel is not mounted), not "skip".
        const actual = reading.costPanel === undefined ? null : reading.costPanel.open === true;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'costPanelCacheHitRatio': {
        const actual = reading.costPanel?.cacheHitRatio ?? null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'costPanelRowLabelsInclude': {
        // Every named row must be drawn. A missing row is a failure, not "unchanged".
        if (!Array.isArray(expected)) {
          failures.push(`${key}: expected an array of row labels`);
          break;
        }
        const labels = Array.isArray(reading.costPanel?.rows)
          ? reading.costPanel.rows.map((/** @type {any} */ row) => row.label)
          : null;
        const missing = labels === null
          ? expected
          : expected.filter((label) => !labels.includes(String(label)));
        if (missing.length > 0) fail(key, expected, { missing, labels });
        break;
      }
      case 'costPanelSegmentKeys': {
        // The segment keys IN DRAW ORDER: a bar that loses or reorders one is observable.
        const actual = Array.isArray(reading.costPanel?.segments)
          ? reading.costPanel.segments.map((/** @type {any} */ segment) => segment.key)
          : null;
        if (!Array.isArray(expected) || !sameJson(actual, expected)) fail(key, expected, actual);
        break;
      }
      case 'costPanelAccountingNoteIncludes': {
        const actual = typeof reading.costPanel?.accountingNote === 'string'
          ? reading.costPanel.accountingNote
          : null;
        if (actual === null || !actual.includes(String(expected))) fail(key, expected, actual);
        break;
      }
      case 'settingsOpen': {
        const actual = reading.settings === null ? false : reading.settings.open === true;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'settingsStatus': {
        const actual = reading.settings === null ? null : reading.settings.status;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'settingsDraftModel': {
        const actual = reading.settings === null ? null : reading.settings.draftModel;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'settingsDraftEffort': {
        const actual = reading.settings === null ? null : reading.settings.draftEffort;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'settingsSavedModel': {
        const actual = reading.settings === null ? null : reading.settings.savedModel;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'settingsSavedEffort': {
        const actual = reading.settings === null ? null : reading.settings.savedEffort;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'settingsEffectiveModel': {
        const actual = reading.settings === null ? null : reading.settings.effectiveModel;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'settingsEffectiveEffort': {
        const actual = reading.settings === null ? null : reading.settings.effectiveEffort;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'settingsRestartRequired': {
        const actual = reading.settings === null ? null : reading.settings.restartRequired;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'settingsError': {
        const actual = reading.settings === null ? null : reading.settings.error;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'codexProvidersOpen': {
        const actual = reading.codexProviders?.open === true;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'codexProvidersStatus': {
        const actual = reading.codexProviders?.status ?? null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'codexProvidersError': {
        const actual = reading.codexProviders?.error ?? null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'codexProvidersCount': {
        const actual = reading.codexProviders?.count ?? null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'codexProviderIds': {
        // The registry's ids IN DRAW ORDER: a row that silently disappears is observable.
        const actual = Array.isArray(reading.codexProviders?.ids) ? reading.codexProviders.ids : null;
        if (!Array.isArray(expected) || !sameJson(actual, expected)) fail(key, expected, actual);
        break;
      }
      case 'codexProviderTokenSet': {
        // Per row, whether a secret is stored — never the secret itself.
        const actual = Array.isArray(reading.codexProviders?.tokenSet)
          ? reading.codexProviders.tokenSet
          : null;
        if (!Array.isArray(expected) || !sameJson(actual, expected)) fail(key, expected, actual);
        break;
      }
      case 'codexProviderWarningsInclude': {
        const warnings = Array.isArray(reading.codexProviders?.warnings)
          ? reading.codexProviders.warnings.join('\n')
          : '';
        if (!warnings.includes(String(expected))) fail(key, expected, warnings);
        break;
      }
      case 'codexResponsesOnlyIncludes': {
        const actual = reading.codexProviders?.responsesOnly ?? null;
        if (actual === null || !actual.includes(String(expected))) fail(key, expected, actual);
        break;
      }
      case 'codexModelProvider': {
        const actual = reading.codexProviders?.modelProvider ?? null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'codexModelProviderOptions': {
        const actual = Array.isArray(reading.codexProviders?.modelProviderOptions)
          ? reading.codexProviders.modelProviderOptions
          : null;
        if (!Array.isArray(expected) || !sameJson(actual, expected)) fail(key, expected, actual);
        break;
      }
      case 'codexModelLibraryStatus': {
        const actual = reading.codexProviders?.modelLibraryStatus ?? null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'codexModelLibraryNoticeIncludes': {
        const actual = reading.codexProviders?.modelLibraryNotice ?? null;
        if (actual === null || !actual.includes(String(expected))) fail(key, expected, actual);
        break;
      }
      case 'codexModelIds': {
        const actual = Array.isArray(reading.codexProviders?.modelIds)
          ? reading.codexProviders.modelIds
          : null;
        if (!Array.isArray(expected) || !sameJson(actual, expected)) fail(key, expected, actual);
        break;
      }
      case 'codexModelLabelsInclude': {
        const labels = Array.isArray(reading.codexProviders?.modelLabels)
          ? reading.codexProviders.modelLabels.join('\n')
          : '';
        if (!labels.includes(String(expected))) fail(key, expected, labels);
        break;
      }
      case 'codexImportOpen': {
        const actual = reading.codexProviders?.importOpen === true;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'codexImportStatus': {
        const actual = reading.codexProviders?.importStatus ?? null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'codexImportCount': {
        const actual = reading.codexProviders?.importCount ?? null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'codexImportIds': {
        // The user-profile rows IN DRAW ORDER (`config.toml` first, then profiles).
        const actual = Array.isArray(reading.codexProviders?.importIds)
          ? reading.codexProviders.importIds
          : null;
        if (!Array.isArray(expected) || !sameJson(actual, expected)) fail(key, expected, actual);
        break;
      }
      case 'codexImportBindable': {
        // A row this project refuses (reserved id / Chat Completions) reads `false` here.
        const actual = Array.isArray(reading.codexProviders?.importBindable)
          ? reading.codexProviders.importBindable
          : null;
        if (!Array.isArray(expected) || !sameJson(actual, expected)) fail(key, expected, actual);
        break;
      }
      case 'codexImportEnvKeys': {
        // The variable NAMES only; a value would have to be a different string.
        const actual = Array.isArray(reading.codexProviders?.importEnvKeys)
          ? reading.codexProviders.importEnvKeys
          : null;
        if (!Array.isArray(expected) || !sameJson(actual, expected)) fail(key, expected, actual);
        break;
      }
      case 'codexImportBaseUrls': {
        const actual = Array.isArray(reading.codexProviders?.importBaseUrls)
          ? reading.codexProviders.importBaseUrls
          : null;
        if (!Array.isArray(expected) || !sameJson(actual, expected)) fail(key, expected, actual);
        break;
      }
      case 'codexImportWireApis': {
        const actual = Array.isArray(reading.codexProviders?.importWireApis)
          ? reading.codexProviders.importWireApis
          : null;
        if (!Array.isArray(expected) || !sameJson(actual, expected)) fail(key, expected, actual);
        break;
      }
      case 'codexImportDirectoryIncludes': {
        const actual = reading.codexProviders?.importDirectory ?? null;
        if (actual === null || !actual.includes(String(expected))) fail(key, expected, actual);
        break;
      }
      case 'codexImportError': {
        const actual = reading.codexProviders?.importError ?? null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'cockpitCardDismissNoticeOk': {
        // The last dismiss answer's outcome, read from the list-level line that outlives the card.
        // `null` (no dismiss attempted yet) is a real reading, not "skip".
        const actual = typeof reading.cockpit?.cards?.dismissNoticeOk === 'boolean'
          ? reading.cockpit.cards.dismissNoticeOk
          : null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'chatMessageCount': {
        const actual = Array.isArray(reading.chat?.messages) ? reading.chat.messages.length : null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'chatMessagesInclude': {
        // Each phrase must be visible in the transcript's RENDERED text. Joined with a newline so
        // a phrase cannot match across two rows by accident of concatenation.
        if (!Array.isArray(expected)) {
          failures.push(`${key}: expected an array of phrases`);
          break;
        }
        const actual = Array.isArray(reading.chat?.messages)
          ? reading.chat.messages.map((/** @type {any} */ message) => message.text).join('\n')
          : null;
        const missing = actual === null
          ? expected
          : expected.filter((phrase) => !actual.includes(String(phrase)));
        if (missing.length > 0) fail(key, expected, { missing, texts: actual });
        break;
      }
      case 'chatMessagesExclude': {
        // The edited turn and everything after it must not be drawn. An empty transcript is the
        // reading this arm exists to catch: `''` contains none of the phrases, so the present
        // assertion above is what keeps exclusion from being satisfied by a blank page.
        if (!Array.isArray(expected)) {
          failures.push(`${key}: expected an array of phrases`);
          break;
        }
        const actual = Array.isArray(reading.chat?.messages)
          ? reading.chat.messages.map((/** @type {any} */ message) => message.text).join('\n')
          : null;
        const present = actual === null
          ? expected
          : expected.filter((phrase) => actual.includes(String(phrase)));
        if (actual === null || present.length > 0) fail(key, expected, { present, texts: actual });
        break;
      }
      case 'composerTextIs': {
        const actual = typeof reading.chat?.composerText === 'string' ? reading.chat.composerText : null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'composerDisabledIs': {
        const actual = reading.composerDisabled === true;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'composerTextIncludes': {
        const actual = typeof reading.chat?.composerText === 'string' ? reading.chat.composerText : null;
        if (actual === null || !actual.includes(String(expected))) fail(key, expected, actual);
        break;
      }
      case 'route': {
        // The pathname the app has navigated to. An opener waits for SOME session route, but a
        // scenario switching between two sessions has to name WHICH one it expects.
        const actual = typeof reading.route === 'string' ? reading.route : null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'sidebarMounted': {
        const actual = reading.sidebar?.mounted === true;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'sidebarRowCount': {
        const actual = Array.isArray(reading.sidebar?.rows) ? reading.sidebar.rows.length : null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'sidebarSessionIds': {
        // Set equality: the list's order is the product's (activity within a project), and a
        // scenario about WHICH sessions the list carries should not pin that order. Use
        // `sidebarSessionIdsInOrder` when the order itself is the assertion.
        const actual = Array.isArray(reading.sidebar?.rows)
          ? reading.sidebar.rows.map((/** @type {any} */ row) => row.sessionId).sort()
          : null;
        if (!Array.isArray(expected) || !sameJson(actual, [...expected].sort())) {
          fail(key, expected, actual);
        }
        break;
      }
      case 'sidebarSessionIdsInOrder': {
        const actual = Array.isArray(reading.sidebar?.rows)
          ? reading.sidebar.rows.map((/** @type {any} */ row) => row.sessionId)
          : null;
        if (!Array.isArray(expected) || !sameJson(actual, expected)) fail(key, expected, actual);
        break;
      }
      case 'sidebarLastActivity': {
        // `{ [sessionId]: ISO }`: every named row must exist AND carry exactly that timestamp.
        // An absent row is a failure, not "unchanged" — that is the arm a refresh losing a row
        // would otherwise satisfy.
        if (!isRecord(expected)) {
          failures.push(`${key}: expected a { sessionId: timestamp } map`);
          break;
        }
        const rows = Array.isArray(reading.sidebar?.rows) ? reading.sidebar.rows : null;
        if (rows === null) {
          fail(key, expected, null);
          break;
        }
        for (const [sessionId, wanted] of Object.entries(expected)) {
          const row = rows.find((/** @type {any} */ candidate) => candidate.sessionId === sessionId);
          if (row === undefined || row.lastActivity !== wanted) {
            fail(`${key}.${sessionId}`, wanted, row === undefined ? 'row missing' : row.lastActivity);
          }
        }
        break;
      }
      case 'sidebarAgeTexts': {
        // `{ [sessionId]: text }`: the age the row actually drew. Asserted by the independent
        // browser leg, where "now" is known and the expected compact age can be computed.
        if (!isRecord(expected)) {
          failures.push(`${key}: expected a { sessionId: ageText } map`);
          break;
        }
        const rows = Array.isArray(reading.sidebar?.rows) ? reading.sidebar.rows : null;
        if (rows === null) {
          fail(key, expected, null);
          break;
        }
        for (const [sessionId, wanted] of Object.entries(expected)) {
          const row = rows.find((/** @type {any} */ candidate) => candidate.sessionId === sessionId);
          if (row === undefined || row.ageText !== wanted) {
            fail(`${key}.${sessionId}`, wanted, row === undefined ? 'row missing' : row.ageText);
          }
        }
        break;
      }
      case 'draftRewriteStateIs': {
        // `chip` (collapsed), `loading`, `candidate`, `error`, or `absent` when the surface is not
        // mounted at all. Read from the composer's own declaration, not inferred from a label.
        const actual = typeof reading.draftRewrite?.state === 'string'
          ? reading.draftRewrite.state
          : null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'draftRewriteCandidateIs': {
        const actual = typeof reading.draftRewrite?.candidate === 'string'
          ? reading.draftRewrite.candidate
          : null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'draftRewriteAvailable': {
        const actual = reading.draftRewrite?.available === true;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'draftRewriteRequestsIs': {
        // How many mock-gateway POSTs the page has made so far. A re-open that spends a second
        // paid request, or a duplicate retry, is therefore observable.
        const actual = typeof reading.draftRewriteRequests === 'number'
          ? reading.draftRewriteRequests
          : null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'debugLogLinesIs': {
        const actual = typeof reading.debugLogLines === 'number' ? reading.debugLogLines : null;
        if (actual !== expected) fail(key, expected, actual);
        break;
      }
      case 'debugLogLinesDeltaIs': {
        // The change since the PREVIOUS step's reading. A scenario that asserts an attempt was
        // (not) recorded states it as a delta, so a pre-existing file with old lines still makes
        // the assertion meaningful.
        const actual = typeof reading.debugLogLines === 'number' && typeof previousDebugLogLines === 'number'
          ? reading.debugLogLines - previousDebugLogLines
          : null;
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
  try {
    await page.waitForFunction(
      () => Boolean(/** @type {any} */ (globalThis).__cloudpitScenario),
      undefined,
      { timeout: BOOT_TIMEOUT_MS },
    );
  } catch (error) {
    // A timeout here has ONE dominant cause, and it is worth naming: the surface is gated on a
    // development build. Without this the run dies on a generic `waitForFunction` timeout that
    // reads like a broken app or a bad scenario, when the page was simply never drivable.
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(
        `the semantic surface (window.__cloudpitScenario) was not mounted within ${BOOT_TIMEOUT_MS}ms. `
        + 'It is installed only by a development build: main.tsx gates it on import.meta.env.DEV '
        + "plus localStorage['ui-scenario']='on'. A page served from a production dist/ build (for "
        + 'example an instance started by scripts/isolated-instance.sh) has no semantic surface to '
        + 'drive. Point --base-url at the Vite dev server instead (`npm run client`, or `npm run dev`).',
      );
    }
    throw error;
  }
}

/** Reads the surface's structured state in one round trip.
 * @param {import('playwright').Page} page
 */
async function readSurface(page) {
  return page.evaluate(() => /** @type {any} */ (globalThis).__cloudpitScenario.read());
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
      const surface = /** @type {any} */ (globalThis).__cloudpitScenario;
      return Boolean(surface) && surface.read().views.length > 0;
    },
    undefined,
    { timeout: PANEL_TIMEOUT_MS },
  );
}

/**
 * The element a click on `text` should land on, or `null` while no such element exists.
 *
 * WHY THE TEXT ELEMENT IS NOT THE CLICK TARGET: the sidebar renders a project's display name and
 * its path suffix side by side in one flex row. When the row's action group and badges squeeze the
 * name, the `truncate` span carrying it measures ZERO width, and Playwright calls a zero-width
 * element invisible even though the row it belongs to is plainly on screen. An unfiltered
 * `.first()` resolves to exactly that span, so `waitFor({ state: 'visible' })` times out and the
 * run reports "the project never appeared" — a lie about the sidebar. Worse, the squeezed span is
 * briefly width>0 while the row's badges load, so a "first visible match" sampled once can be a
 * target that stops being visible a frame later. The ROW the text sits in does not have that race.
 *
 * The preference order is:
 *   1. the nearest visible button/anchor/[role=button] row of each match, in DOM order — the row
 *      that owns the text, whether or not the text span itself is clickable;
 *   2. the first exact match Playwright judges visible (a row div with its own click handler and
 *      no role — the session rows' shape);
 *   3. the nearest visible ancestor of the first match (a row that is neither).
 *
 * @param {import('playwright').Page} page
 * @param {string} text
 * @returns {Promise<import('playwright').Locator | null>}
 */
async function clickTargetForText(page, text) {
  const matches = page.getByText(text, { exact: true });
  const matchCount = await matches.count();
  if (matchCount === 0) return null;

  // `ancestor-or-self` is in reverse document order, so `[1]` is the NEAREST row — not the whole
  // sidebar. `filter({ visible: true })` on it makes a collapsed/hidden row ineligible.
  for (let index = 0; index < matchCount; index += 1) {
    const row = matches
      .nth(index)
      .locator('xpath=ancestor-or-self::*[self::button or self::a or @role="button"][1]')
      .filter({ visible: true })
      .first();
    if (await row.count() > 0) return row;
  }

  const visibleMatch = matches.filter({ visible: true }).first();
  if (await visibleMatch.count() > 0) return visibleMatch;

  const visibleAncestor = matches.first().locator('xpath=ancestor::*').filter({ visible: true }).first();
  if (await visibleAncestor.count() > 0) return visibleAncestor;
  return null;
}

/**
 * Waits until `text` has a click target, polling for it rather than waiting on one locator's
 * visibility: which element is clickable depends on the row's layout, and it can change while the
 * document boots.
 *
 * @param {import('playwright').Page} page
 * @param {string} text
 * @param {number} timeout
 * @returns {Promise<import('playwright').Locator | null>}
 */
async function waitForClickTarget(page, text, timeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let target = null;
    try {
      target = await clickTargetForText(page, text);
    } catch {
      // A document that was replaced mid-navigation has no DOM to query yet; that is "not yet",
      // not a failure — the same reload window the bounded retries below were written for.
      target = null;
    }
    if (target !== null) return target;
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(250);
  }
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
  await page.goto('/');
  let projectRow = await waitForClickTarget(page, target.project, 10_000);
  for (let attempt = 0; projectRow === null && attempt < 2; attempt += 1) {
    await page.reload().catch(() => undefined);
    projectRow = await waitForClickTarget(page, target.project, 6_000);
  }
  if (projectRow === null) {
    throw new Error(`the fixture project "${target.project}" never appeared in the sidebar`);
  }

  await projectRow.click();
  let sessionRow = await waitForClickTarget(page, target.session, 10_000);
  if (sessionRow === null) {
    // A project that is already expanded — the selected project auto-expands on
    // mount — COLLAPSES on the row click, because the row click is the same
    // toggle a person uses. Pressing it once more re-opens the project, which is
    // the second click a person makes when the first one hides what they wanted.
    const projectRowAgain = await waitForClickTarget(page, target.project, 4_000);
    if (projectRowAgain !== null) {
      await projectRowAgain.click();
      sessionRow = await waitForClickTarget(page, target.session, 10_000);
    }
  }
  if (sessionRow === null) {
    throw new Error(`the session "${target.session}" never appeared under the project "${target.project}"`);
  }
  await sessionRow.click();
}

/** True when the page's path is a session workspace route. */
const SESSION_ROUTE = /\/session\/[^/]+/;

/**
 * Resolves a scenario's session NAMES to the server's session id.
 *
 * The mobile layout is a different entry path (the sidebar drawer's project/session gestures do
 * not route the same way as the desktop two-column view), so a phone-width run opens the
 * product's own `/session/<id>` route directly. The id comes from the server's own project
 * reading — never a fabricated one — and the display name is matched exactly as the sidebar
 * shows it.
 *
 * @param {import('playwright').Page} page
 * @param {{ project: string, session: string }} target
 * @param {string} authToken
 */
async function resolveSessionId(page, target, authToken) {
  const response = await page.request.get('/api/projects', {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  if (!response.ok()) return null;
  const projects = await response.json().catch(() => null);
  if (!Array.isArray(projects)) return null;
  const project = projects.find((/** @type {any} */ candidate) => (
    candidate.displayName === target.project
    || String(candidate.path ?? '').endsWith(`/${target.project}`)
    || String(candidate.fullPath ?? '').endsWith(`/${target.project}`)
  ));
  const sessions = Array.isArray(project?.sessions) ? project.sessions : [];
  const match = sessions.find((/** @type {any} */ session) => (
    session.id === target.session
    || session.summary === target.session
    || session.title === target.session
  ));
  return typeof match?.id === 'string' ? match.id : null;
}

/**
 * Opens one session's workspace.
 *
 * TWO WAYS IN, ONE READING. From a cold page this is the sidebar selection a person makes. From
 * the cockpit it is the mode switch's 「会话」 segment, which lands on the route the cockpit
 * recorded when it was entered — the product's own return path, not a URL the runner invents.
 * The cold fallback keeps the opener usable when no route was recorded (a scenario that opens
 * `session` first).
 *
 * PHONE WIDTH OPENS THE ROUTE DIRECTLY. Below the `md` boundary the sidebar is a drawer and the
 * project/session rows navigate differently; the scenario's subject is not those gestures, so
 * the id resolved from the server's project reading is opened at the product's own
 * `/session/<id>` address. The page is the same page either way.
 *
 * @param {import('playwright').Page} page
 * @param {{ project: string, session: string }} target
 * @param {string} authToken
 */
async function openSession(page, target, authToken) {
  if ((page.viewportSize()?.width ?? 1280) < 768) {
    const id = await resolveSessionId(page, target, authToken);
    if (id !== null) {
      await page.goto(`/session/${encodeURIComponent(id)}`);
      await waitForSurface(page);
      // The composer hydrates its stored draft after the route mounts. A scenario that types
      // immediately can have that hydration land on top of the typed bytes; wait for the box and
      // one settle beat so the scenario's own typing is the last write.
      await page.locator('[data-slot="prompt-input-textarea"]').first().waitFor({
        state: 'visible',
        timeout: BOOT_TIMEOUT_MS,
      });
      await page.waitForTimeout(750);
      return;
    }
  }
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
 * Opens the cockpit's cards view.
 *
 * The mode switch is the product's entry into the cockpit — and it is what records the return
 * path a later `session` step reads. The cards view itself is one of the cockpit's own views,
 * addressed by its query grammar (`?view=cards`, the inverse of `formatCockpitView`); the app
 * draws no separate cards link, so the stage's own address is the product path to it.
 *
 * @param {import('playwright').Page} page
 */
async function openCockpitCards(page) {
  await openCockpit(page);
  await page.goto('/cockpit?view=cards');
  await page.locator('[data-testid="cockpit-page"][data-cockpit-view="cards"]').first().waitFor({
    state: 'visible',
    timeout: PANEL_TIMEOUT_MS,
  });
  await page.locator('[data-testid="cockpit-card-list"]').first().waitFor({
    state: 'visible',
    timeout: PANEL_TIMEOUT_MS,
  });
  await waitForSurface(page);
  // Loaded, empty or failed — all three are settled states; waiting here keeps a scenario's
  // first reading from catching the list between its mount and its first cards.
  await page.waitForFunction(
    () => {
      // `globalThis` rather than `document`: this file is typechecked under Node's lib only.
      const list = /** @type {any} */ (globalThis).document.querySelector(
        '[data-testid="cockpit-card-list"]',
      );
      if (list === null) return false;
      return list.querySelector('[data-cockpit-card-id]') !== null
        || list.querySelector('[data-testid="cockpit-card-empty"]') !== null
        || list.querySelector('[data-testid="cockpit-card-error"]') !== null;
    },
    undefined,
    { timeout: PANEL_TIMEOUT_MS },
  );
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
 * Opens the Settings dialog's Cockpit tab.
 *
 * The dialog has no route of its own: it is the sidebar header's Settings button, and the tab is
 * the same nav item a person presses. The opener then waits for the form's published status to
 * settle (`ready` or `failed`), because its catalogue and reading arrive over the network and a
 * scenario's first `expect` must not catch it in `loading`.
 *
 * @param {import('playwright').Page} page
 */
async function openSettingsCockpit(page) {
  if (!page.url().startsWith('http')) {
    await page.goto('/');
  }
  await waitForSurface(page);
  const opener = page.locator('[data-testid="open-settings"]:visible').first();
  await opener.waitFor({ state: 'visible', timeout: BOOT_TIMEOUT_MS });
  await opener.click();
  const tab = page.locator('[data-settings-tab="cockpit"]:visible').first();
  await tab.waitFor({ state: 'visible', timeout: BOOT_TIMEOUT_MS });
  await tab.click();
  await page.waitForFunction(
    () => {
      const form = /** @type {any} */ (globalThis).document.querySelector(
        '[data-cockpit-session-start]',
      );
      if (form === null) return false;
      const status = form.getAttribute('data-cockpit-session-start');
      return status === 'ready' || status === 'failed';
    },
    undefined,
    { timeout: PANEL_TIMEOUT_MS },
  );
}

/**
 * Opens Settings → Agents → Codex → Models: the project provider registry with the bound model
 * library below it.
 *
 * The dialog has no route of its own, so the opener presses the same four controls a person
 * does: the sidebar's Settings button, the Agents tab, the Codex agent pill, and the Models
 * category tab. It then waits for the registry's own published status to settle (`ready` or
 * `failed`), because the reading arrives over the network and a scenario's first `expect` must
 * not catch it in `loading`.
 *
 * @param {import('playwright').Page} page
 */
async function openSettingsAgentsCodex(page) {
  if (!page.url().startsWith('http')) {
    await page.goto('/');
  }
  await waitForSurface(page);
  const opener = page.locator('[data-testid="open-settings"]:visible').first();
  await opener.waitFor({ state: 'visible', timeout: BOOT_TIMEOUT_MS });
  await opener.click();
  const tab = page.locator('[data-settings-tab="agents"]:visible').first();
  await tab.waitFor({ state: 'visible', timeout: BOOT_TIMEOUT_MS });
  await tab.click();
  const agent = page.locator('[data-settings-agent="codex"]:visible').first();
  await agent.waitFor({ state: 'visible', timeout: BOOT_TIMEOUT_MS });
  await agent.click();
  const category = page.locator('[data-settings-category="models"]:visible').first();
  await category.waitFor({ state: 'visible', timeout: BOOT_TIMEOUT_MS });
  await category.click();
  await page.waitForFunction(
    () => {
      const root = /** @type {any} */ (globalThis).document.querySelector('[data-codex-providers]');
      if (root === null) return false;
      const status = root.getAttribute('data-codex-providers');
      // The user-profile import is a second, independent read; a scenario whose first step
      // asserts it must not catch it mid-load.
      const importStatus = root.getAttribute('data-codex-import-status');
      return (status === 'ready' || status === 'failed')
        && (importStatus === 'ready' || importStatus === 'failed');
    },
    undefined,
    { timeout: PANEL_TIMEOUT_MS },
  );
}

/**
 * Opens the title-bar Loop pulse popover for the session already on screen.
 *
 * The popover is the product's own dashboard entry (the header trigger), and its mention list is
 * a separate, slower read than the session workspace: this opener waits until that list has
 * settled into one of its own states, so a scenario's first `expect` reads mentions rather than a
 * spinner. The tasks fold their done rows by default, so the opener expands that group — a
 * scenario about WHICH tasks were mentioned has to read the whole list, not the open half. A
 * popover that is already open is left alone; the trigger would toggle it closed.
 *
 * @param {import('playwright').Page} page
 */
async function openQuayPulse(page) {
  const trigger = page.locator('[data-testid="quay-pulse-trigger"]:visible').first();
  await trigger.waitFor({ state: 'visible', timeout: BOOT_TIMEOUT_MS });
  const popover = page.locator('[data-testid="quay-pulse-popover"]');
  const alreadyOpen = await popover.isVisible().catch(() => false);
  if (!alreadyOpen) {
    await trigger.click();
  }
  await popover.waitFor({ state: 'visible', timeout: PANEL_TIMEOUT_MS });
  await page.waitForFunction(
    () => {
      const dialog = /** @type {any} */ (globalThis).document.querySelector(
        '[data-testid="quay-pulse-popover"]',
      );
      if (dialog === null) return false;
      return dialog.querySelector('[data-testid="quay-pulse-tasks"]') !== null
        || dialog.querySelector('[data-testid="quay-pulse-goals"]') !== null
        || dialog.querySelector('[data-testid="quay-pulse-empty"]') !== null
        || dialog.querySelector('[data-testid="quay-pulse-list-error"]') !== null
        || dialog.querySelector('[data-testid="quay-pulse-transcript-error"]') !== null;
    },
    undefined,
    { timeout: PANEL_TIMEOUT_MS },
  );
  const doneToggle = popover.locator('[data-testid="quay-pulse-done-toggle"]').first();
  if ((await doneToggle.count()) > 0 && (await doneToggle.isVisible().catch(() => false))) {
    await doneToggle.click();
    // The fold is a React state update; let its commit land before the caller's reading.
    await page.waitForTimeout(100);
  }
}

/**
 * Opens the `/cost` modal for the session already on screen.
 *
 * THE COMMAND IS THE ENTRY. The panel is not a route and has no test hook of its own: a person
 * types `/cost` into the composer and picks the menu's row, so the opener does the same rather
 * than reaching into React state. Picking the row (instead of pressing Enter) is what keeps the
 * text from being submitted as a chat message: selecting a built-in command executes it and
 * preserves the composer content. The opener then waits for the panel to declare itself mounted,
 * so the first reading observes the drawn rows rather than a command still in flight.
 *
 * @param {import('playwright').Page} page
 * @param {{ project: string, session: string }} target
 * @param {string} authToken
 */
async function openCostPanel(page, target, authToken) {
  // The `/cost` command forwards the client's own `tokenBudget` as the usage context, and that
  // budget arrives from the session's token-usage fetch AFTER the workspace mounts. Executing
  // before it lands renders the LEGACY layout (used 0 / Breakdown Unavailable) — a race in the
  // page, not a scenario state — so the opener waits for that fetch (bounded: a session that
  // reports none simply leaves the legacy layout, which is itself a legitimate reading).
  const tokenUsage = page
    .waitForResponse((response) => /\/token-usage(\?|$)/.test(new URL(response.url()).pathname), {
      timeout: 15_000,
    })
    .catch(() => null);
  await openSession(page, target, authToken);
  await tokenUsage;
  // Let the budget's React commit reach the command handler's closure before typing.
  await page.waitForTimeout(300);

  const textarea = page.locator('[data-slot="prompt-input-textarea"]:visible').first();
  await textarea.waitFor({ state: 'visible', timeout: BOOT_TIMEOUT_MS });
  await textarea.click();
  await textarea.fill('/cost');
  const option = page.getByRole('option').filter({ hasText: '/cost' }).first();
  await option.waitFor({ state: 'visible', timeout: PANEL_TIMEOUT_MS });
  await option.click();
  await page.locator('[data-testid="cost-panel"]').first().waitFor({
    state: 'visible',
    timeout: PANEL_TIMEOUT_MS,
  });
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
 *   viewport?: { width: number, height: number },
 *   mock?: { responses: unknown[] } | null,
 *   debugLogFile?: string,
 * }} options
 * @returns {Promise<{ report: any, ok: boolean }>}
 */
async function runScenario(browser, scenario, options) {
  const startedAt = Date.now();
  const context = await browser.newContext({
    baseURL: options.baseUrl,
    viewport: options.viewport ?? { width: 1280, height: 800 },
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
  /** How many draft-rewrite POSTs the local mock gateway has answered for this run. */
  const gatewayCounter = { count: 0 };
  if (options.mock !== null && options.mock !== undefined) {
    const responses = Array.isArray(options.mock.responses) ? options.mock.responses : [];
    await page.route('**/api/reply-suggestions/draft-rewrite', async (route) => {
      const index = Math.min(gatewayCounter.count, Math.max(0, responses.length - 1));
      gatewayCounter.count += 1;
      const entry = /** @type {{ status?: number, body?: unknown, delayMs?: number }} */ (
        responses[index] ?? { status: 200, body: { rewrittenText: '' } }
      );
      if (typeof entry.delayMs === 'number' && entry.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, entry.delayMs));
      }
      await route.fulfill({
        status: typeof entry.status === 'number' ? entry.status : 200,
        contentType: 'application/json',
        body: JSON.stringify(entry.body ?? {}),
      });
    });
  }
  /** Adds the locally observed request count to the page's own reading.
   * @param {any} reading
   */
  /**
   * The server-side debug ledger path. `--debug-log-file` overrides it (an isolated instance
   * with its own HOME passes its own path there); the default is the shipped location.
   */
  const debugLogFile = options.debugLogFile
    ?? path.join(os.homedir(), '.cloudpit', 'reply-suggestions-debug.jsonl');
  /** @type {(reading: any) => any} */
  const withGatewayReading = (reading) => (
    reading === null || typeof reading !== 'object'
      ? reading
      : {
        ...reading,
        draftRewriteRequests: gatewayCounter.count,
        debugLogLines: countDebugLogLines(debugLogFile),
      }
  );
  /** @type {StepResult[]} */
  const results = [];
  /** @type {{ step: ScenarioStep, index: number }[]} */
  let batch = [];
  /**
   * The debug-ledger line count read at the previous step, for `debugLogLinesDeltaIs`.
   * @type {number | null}
   */
  let previousDebugLogLines = null;

  /**
   * Runs the accumulated in-page steps in ONE evaluate and records their results.
   *
   * Checkpoints end a batch: a screenshot has to happen between steps, so a batch never spans
   * one. This is what keeps the run's round trips proportional to checkpoints, not steps.
   */
  const flushBatch = async () => {
    if (batch.length === 0) return;
    const readings = await page.evaluate(async (steps) => {
      const surface = /** @type {any} */ (globalThis).__cloudpitScenario;
      /** @type {any[]} */
      const results = [];
      for (const step of steps) {
        if (step.drive !== undefined) {
          surface.drive(step.drive);
          // A `cockpitCard.confirm` sends a real confirmation; await it before reading, so the
          // step reports the settled card AND the request is not aborted by the next navigation
          // or by the context closing after the last step.
          if (typeof surface.settle === 'function') await surface.settle();
        }
        results.push(surface.read());
      }
      return results;
    }, batch.map((entry) => entry.step));

    for (let i = 0; i < batch.length; i += 1) {
      const entry = batch[i];
      const step = entry.step;
      const reading = withGatewayReading(readings[i]);
      const checkpoint = step.checkpoint === true;
      let screenshot = null;
      if (checkpoint) {
        const file = path.join(options.outDir, `step-${entry.index + 1}-${stepAction(step).replace(/[:/]/g, '-')}.png`);
        await page.screenshot({ path: file, fullPage: true });
        screenshot = file;
      }
      const failures = expectationFailures(step.expect ?? {}, reading, previousDebugLogLines);
      results.push({
        index: entry.index + 1,
        action: stepAction(step),
        ok: failures.length === 0,
        failures,
        checkpoint,
        screenshot,
        reading,
      });
      if (typeof reading.debugLogLines === 'number') previousDebugLogLines = reading.debugLogLines;
    }
    batch = [];
  };

  /** True once a document of the app is loaded with the surface installed. */
  let appReady = false;

  try {
    for (let index = 0; index < scenario.steps.length; index += 1) {
      const step = scenario.steps[index];
      if (!appReady && step.open === undefined && step.reload !== true) {
        // A scenario that never opens a view still needs the app under it.
        await page.goto('/');
        await waitForSurface(page);
        appReady = true;
      }
      if (step.open !== undefined || step.reload === true) {
        await flushBatch();
        if (step.reload === true) {
          // A real refresh: the document, the client store and the history cache all start over.
          await page.reload();
          await waitForSurface(page);
          if (step.waitForCards === true) {
            // A reloaded cards view fetches its list after the surface mounts. Waiting for one
            // drawn card is what separates "the reload has not fetched yet" from "the reload
            // lost the card" — the two outcomes a knowledge-state step must tell apart.
            await page.waitForFunction(
              () => {
                const surface = /** @type {any} */ (globalThis).__cloudpitScenario;
                return surface !== undefined
                  && Array.isArray(surface.read().cockpit?.cards?.visibleCardIds)
                  && surface.read().cockpit.cards.visibleCardIds.length > 0;
              },
              undefined,
              { timeout: BOOT_TIMEOUT_MS },
            );
          }
          if (step.waitForChat === true) {
            // A session route loads its history after the surface mounts. Waiting for one drawn
            // row is what separates "the reload has not fetched yet" from "the reload lost the
            // conversation" — the two outcomes this leg exists to tell apart.
            await page.waitForFunction(
              () => {
                const surface = /** @type {any} */ (globalThis).__cloudpitScenario;
                return surface !== undefined
                  && Array.isArray(surface.read().chat?.messages)
                  && surface.read().chat.messages.length > 0;
              },
              undefined,
              { timeout: BOOT_TIMEOUT_MS },
            );
          }
          appReady = true;
        } else {
          // An opener may address its own session; that is how one scenario switches between two.
          const target = {
            project: step.project ?? options.project,
            session: step.session ?? options.session,
          };
          /** @type {Record<string, (() => Promise<void>) | undefined>} */
          const openers = {
            'quay-panel': () => openQuayPanel(page, target),
            session: () => openSession(page, target, options.authToken),
            cockpit: () => openCockpit(page),
            'cockpit-cards': () => openCockpitCards(page),
            settings: () => openSettingsCockpit(page),
            'settings-agents-codex': () => openSettingsAgentsCodex(page),
            'quay-pulse': () => openQuayPulse(page),
            'cost-panel': () => openCostPanel(page, target, options.authToken),
          };
          const execute = step.open === undefined ? undefined : openers[step.open];
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
        }
        const reading = withGatewayReading(await readSurface(page));
        let screenshot = null;
        if (step.checkpoint === true) {
          const file = path.join(options.outDir, `step-${index + 1}-${stepAction(step).replace(/[:/]/g, '-')}.png`);
          await page.screenshot({ path: file, fullPage: true });
          screenshot = file;
        }
        const failures = expectationFailures(step.expect ?? {}, reading, previousDebugLogLines);
        results.push({
          index: index + 1,
          action: stepAction(step),
          ok: failures.length === 0,
          failures,
          checkpoint: step.checkpoint === true,
          screenshot,
          reading,
        });
        if (typeof reading.debugLogLines === 'number') previousDebugLogLines = reading.debugLogLines;
        continue;
      }

      if (step.debugLog !== undefined) {
        // A NODE-SIDE step: the debug ledger is a server file, so neither the page nor its
        // `--mock-gateway` route can observe it. Playwright's request context bypasses page
        // routes, which is exactly why the server (not the mock) records this attempt.
        await flushBatch();
        const headers = { authorization: `Bearer ${options.authToken}` };
        let failure = null;
        if (typeof step.debugLog.set === 'boolean') {
          const response = await page.request.put('/api/reply-suggestions/debug-log', {
            headers,
            data: { enabled: step.debugLog.set },
          });
          if (!response.ok()) failure = `PUT /debug-log answered ${response.status()}`;
        }
        if (typeof step.debugLog.rewrite === 'string') {
          const response = await page.request.post('/api/reply-suggestions/draft-rewrite', {
            headers,
            data: {
              text: step.debugLog.rewrite,
              ...(typeof step.debugLog.sessionId === 'string' ? { sessionId: step.debugLog.sessionId } : {}),
            },
          });
          if (!response.ok()) failure = `POST /draft-rewrite answered ${response.status()}`;
        }
        const reading = withGatewayReading(await readSurface(page));
        let screenshot = null;
        if (step.checkpoint === true) {
          const file = path.join(options.outDir, `step-${index + 1}-${stepAction(step).replace(/[:/]/g, '-')}.png`);
          await page.screenshot({ path: file, fullPage: true });
          screenshot = file;
        }
        const failures = failure === null
          ? expectationFailures(step.expect ?? {}, reading, previousDebugLogLines)
          : [failure, ...expectationFailures(step.expect ?? {}, reading, previousDebugLogLines)];
        results.push({
          index: index + 1,
          action: stepAction(step),
          ok: failures.length === 0,
          failures,
          checkpoint: step.checkpoint === true,
          screenshot,
          reading,
        });
        if (typeof reading.debugLogLines === 'number') previousDebugLogLines = reading.debugLogLines;
        continue;
      }

      if (typeof step.waitFor === 'string') {
        // A state produced by an asynchronous answer: the page must be given real time, which a
        // synchronous `drive` cannot observe. This ends the current batch, waits in the browser,
        // then reads the page exactly like an opener step.
        await flushBatch();
        const [kind, wanted] = step.waitFor.split(':');
        let waitFailure = null;
        if (kind !== 'draftRewrite' || wanted === undefined) {
          waitFailure = `unsupported waitFor ${JSON.stringify(step.waitFor)}`;
        } else {
          try {
            await page.waitForFunction(
              (state) => {
                const doc = /** @type {any} */ (globalThis).document;
                const root = doc.querySelector('[data-slot="draft-rewrite"]');
                return root !== null && root.getAttribute('data-draft-rewrite-state') === state;
              },
              wanted,
              { timeout: typeof step.timeoutMs === 'number' ? step.timeoutMs : BOOT_TIMEOUT_MS },
            );
          } catch {
            waitFailure = `the draft-rewrite surface never reached state ${JSON.stringify(wanted)}`;
          }
        }
        const reading = withGatewayReading(await readSurface(page));
        let screenshot = null;
        if (step.checkpoint === true) {
          const file = path.join(options.outDir, `step-${index + 1}-${stepAction(step).replace(/[:/]/g, '-')}.png`);
          await page.screenshot({ path: file, fullPage: true });
          screenshot = file;
        }
        const failures = waitFailure === null
          ? expectationFailures(step.expect ?? {}, reading, previousDebugLogLines)
          : [waitFailure, ...expectationFailures(step.expect ?? {}, reading, previousDebugLogLines)];
        results.push({
          index: index + 1,
          action: stepAction(step),
          ok: failures.length === 0,
          failures,
          checkpoint: step.checkpoint === true,
          screenshot,
          reading,
        });
        if (typeof reading.debugLogLines === 'number') previousDebugLogLines = reading.debugLogLines;
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
    viewport: options.viewport ?? { width: 1280, height: 800 },
    mockGateway: options.mock === null || options.mock === undefined
      ? { used: false, requests: gatewayCounter.count }
      : {
        used: true,
        note: 'local injected mock gateway — proves the wiring/contract only, not real model quality',
        requests: gatewayCounter.count,
      },
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

  let viewport = { width: 1280, height: 800 };
  if (flags.viewport !== undefined) {
    const match = /^(\d+)x(\d+)$/.exec(flags.viewport);
    if (match === null) return usage('--viewport must be WIDTHxHEIGHT (e.g. 375x720)');
    viewport = { width: Number(match[1]), height: Number(match[2]) };
  }

  let mock = null;
  if (flags['mock-gateway'] !== undefined) {
    try {
      mock = JSON.parse(fs.readFileSync(flags['mock-gateway'], 'utf8'));
    } catch (error) {
      return usage(`--mock-gateway could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (mock === null || typeof mock !== 'object' || !Array.isArray(mock.responses)) {
      return usage('--mock-gateway must be a JSON object with a `responses` array');
    }
  } else if (scenario.mockGateway !== undefined) {
    // A scenario that ships its own local gateway responses needs no second file (and no flag):
    // the report still says the gateway was a local injection, not a real model.
    mock = scenario.mockGateway;
    if (mock === null || typeof mock !== 'object' || !Array.isArray(mock.responses)) {
      return usage('scenario.mockGateway must be an object with a `responses` array');
    }
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const { report, ok } = await runScenario(browser, scenario, {
      baseUrl: baseUrl ?? '',
      authToken: authToken ?? '',
      project: project ?? '',
      session: session ?? '',
      outDir,
      scenarioFile,
      viewport,
      mock,
      ...(flags['debug-log-file'] === undefined
        ? {}
        : { debugLogFile: path.resolve(flags['debug-log-file']) }),
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
