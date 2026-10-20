import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { BrowserContext, Locator, Page } from '@playwright/test';

// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data dir),
// recording through the app's own voice button. The recorder is the browser's own: Chromium is launched with a
// fake audio device whose samples come from the WAV playwright.config.ts wrote before the servers booted, so
// `getUserMedia` hands `MediaRecorder` a real stream and the app's own hook encodes what it hears.
//
// WHAT THIS FILE READS, said once because every claim below is bounded by it: the recogniser is answered in the
// browser (`page.route`), and the interface language is Chinese, so what is under test is the DISPLAY surface —
// which sentence a failure gets, how long it stays, what a fold hides, and what a failure does to the draft.
// The four upstream conditions are produced by one stand-in whose answer is swapped between legs; the app's own
// classification of them (the vocabulary, the envelope, the code→sentence mapping) belongs to four sibling
// criteria and is consumed here rather than reimplemented. This file reads the PAGE, never the server's
// classification. See the registration line printed at the end for the full list of what is and is not done.
//
// ONE PAGE FOR FOUR LEGS, deliberately: playwright.config.ts arms a 55s watchdog over the whole invocation (and
// a 60s goal gate above that), and e2e/voice-trim.spec.ts already measures 41s in this checkout. Re-opening a
// page and re-running onboarding per leg would spend that budget on the fixture instead of on the readings, so
// the legs share one context and one page and change only the stand-in's answer. The interceptors are
// registered once, per page, for the same reason — a second `page.route` on the same pattern would stack a
// second handler onto the first leg's closure.

const DATA_DIR = process.env.QUAY_E2E_DATA_DIR!;
const CLIENT_URL = `http://127.0.0.1:${process.env.QUAY_E2E_CLIENT_PORT}`;
const WORKSPACE = path.join(DATA_DIR, 'voice-error-messages-workspace');
const SESSION_ID = 'e2e-voice-error-messages';
const SESSION_NAME = 'voice-error-messages';
/** Where the fake microphone reads its samples from; the config wrote it before the browser was launched. */
const AUDIO_FILE = process.env.QUAY_E2E_VOICE_ERROR_AUDIO!;
/**
 * Where the config recorded whether its watchdog was armed, and whether it ever fired.
 *
 * The `[e2e] watchdog:` line itself goes to the *runner's* stdout, which a spec cannot read — so this file reads
 * the same two facts the line encodes, written by the same two sites that write it (config evaluation for the
 * arming, `endRun` for the firing). An exit-0 run that got as far as printing its ledger is itself a run whose
 * watchdog did not fire; this file is the machine-readable half of that, and `armed:true` is the positive
 * control that keeps "no watchdog line" from being satisfied by a watchdog that was never armed at all.
 */
const WATCHDOG_STATE_FILE = path.join(DATA_DIR, 'watchdog-state.json');

/** How long each leg holds the recorder open. Same value as the sibling voice specs; see `recordOnce`. */
const CAPTURE_MS = 1_500;

/** The proxy hop the app takes for a provider declaring `transport: 'proxy-only'`. */
const PROXY_PATH = /\/api\/voice\/transcribe/;

/**
 * The address typed into the provider's own endpoint field.
 *
 * It is a workspace hostname of the shape that provider's declaration accepts (`<workspace>.<region>.maas.
 * aliyuncs.com`, https, no port), and the shape is load-bearing even for a file that never lets a request leave
 * the machine: every settings save re-validates the stored address against that rule, and an address the rule
 * refuses is a save the server answers 400 to — the leg would then be recording through whatever provider was
 * stored before, with the same green output.
 */
const WORKSPACE_ADDRESS = 'https://voice-e2e-check.cn-hangzhou.maas.aliyuncs.com';
/** The credential typed into the provider's own key field. A sentinel; it never leaves this machine. */
const API_KEY = 'sk-e2e-voice-error-1c93b7';
/** The per-user model typed into the provider's own model field. */
const MODEL = 'qwen3.8-omni-flash';

/** The sentence that leaves the composer's textarea as a person's own typing, the thing every failure below is judged against. */
const DRAFTS_ARE_KEPT = 'keep this failure-message draft character for character';

/**
 * The shipped sentences, read off the disk at run time.
 *
 * WHY THE SENTENCE IS NOT RESTATED HERE. Which copy a failure gets is a function of the locale file and of the
 * code, so a string typed into this file is one that stops moving when the locale does. Read here, an edit to
 * `src/modules/i18n/locales/zh-CN/chat.json` moves the expectation with it — and the English file is read as
 * well, because "the page is showing Chinese" is only a reading if the Chinese sentence is known to be a
 * different string from the English one at the same key.
 */
const readLocale = <T>(language: string, namespace: string): T =>
  JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), `src/modules/i18n/locales/${language}/${namespace}.json`), 'utf8'),
  ) as T;

type ChatLocale = { voice: { input: string; stopRecording: string; errors: Record<string, string> } };
type CommonLocale = { navigation: { settings: string }; buttons: { close: string } };
type SettingsLocale = { mainTabs: { voice: string }; voiceSettings: { enable: string } };

const ZH_CHAT = readLocale<ChatLocale>('zh-CN', 'chat');
const EN_CHAT = readLocale<ChatLocale>('en', 'chat');
const ZH_COMMON = readLocale<CommonLocale>('zh-CN', 'common');
const ZH_SETTINGS = readLocale<SettingsLocale>('zh-CN', 'settings');

/** Every leaf of a locale file as a dotted key, so one label can be resolved out of two languages. */
const flattenLocale = (source: Record<string, unknown>, prefix = ''): Record<string, string> => {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') {
      flat[`${prefix}${key}`] = value;
      continue;
    }
    if (typeof value === 'object' && value !== null) {
      Object.assign(flat, flattenLocale(value as Record<string, unknown>, `${prefix}${key}.`));
    }
  }
  return flat;
};

const ZH_AUTH = flattenLocale(readLocale<Record<string, unknown>>('zh-CN', 'auth'));
const EN_AUTH = flattenLocale(readLocale<Record<string, unknown>>('en', 'auth'));

/**
 * The account wizard's labels, resolved the way the APP resolves them: the Chinese file first, the English file
 * for whatever key it does not publish.
 *
 * The fallback is not a convenience, it is the app's own (`fallbackLng: 'en'`), and the two files really are
 * mixed: the Chinese auth file publishes `register.*` — so the submit button reads 创建账户 — and publishes no
 * `onboarding.*` at all, so the git step of the same wizard is English ("John Doe", "Next", "Complete Setup").
 * Reading each label through this helper keeps the wizard drivable without a second, hand-kept table of which
 * keys are translated, and the interface behind the wizard is Chinese either way, which is what this file is
 * about.
 */
const authLabel = (key: string): string => ZH_AUTH[key] ?? EN_AUTH[key];

const WIZARD = {
  submit: authLabel('register.submit'),
  namePlaceholder: authLabel('onboarding.gitNamePlaceholder'),
  emailPlaceholder: authLabel('onboarding.gitEmailPlaceholder'),
  next: authLabel('onboarding.next'),
  completeSetup: authLabel('onboarding.completeSetup'),
};

/**
 * The four accessible names and the one close label this file drives the UI by.
 *
 * Read from the shipped locale files rather than typed, so pinning the interface to Chinese does not also pin
 * this file to a copy of those four strings; the same reason the sentences above are read.
 */
const UI = {
  settings: ZH_COMMON.navigation.settings,
  close: ZH_COMMON.buttons.close,
  voiceTab: ZH_SETTINGS.mainTabs.voice,
  enableVoice: ZH_SETTINGS.voiceSettings.enable,
  record: ZH_CHAT.voice.input,
  stop: ZH_CHAT.voice.stopRecording,
};

/** One row of the health payload, as much of it as this file reads. */
type HealthRow = {
  id: string;
  configured: boolean;
  capabilities?: { transport?: string };
  credentialFields?: { endpointField: string; apiKeyField: string; modelField?: string };
};

type HealthPayload = { configured?: boolean; provider?: string; providers?: HealthRow[] };

/**
 * One leg: an upstream condition, the envelope that produces it, and what the page is expected to read.
 *
 * The status and the envelope are the stand-in's own inputs; `expectedCode` is the vocabulary member the page's
 * sentence must be selected by; `codeReading` is what this file prints as the leg's `code` — the envelope's own
 * code, or `local-empty` for the leg whose emptiness is found in the page's chain rather than in an answer.
 */
type LegSpec = {
  name: string;
  status: number;
  envelope: Record<string, unknown>;
  expectedCode: string;
  codeReading: string;
  upstreamCode: string | null;
};

/**
 * The four envelopes, in the shape the task's proposal fixes (`{ error, code, upstreamCode? }`).
 *
 * ONE DEVIATION, registered here and in the output: the real proxy republishes a code for the refusals it makes
 * itself and answers an upstream refusal with a message alone, so `ACCOUNT_ACCESS`/`MODEL_NOT_FOUND` beside a
 * recogniser code are the stand-in supplying the classification the page's sentence is chosen by. That is the
 * same deviation AC-142's own double carries, and it is deliberate: this file reads what the page does with an
 * envelope, and an envelope without the codes could not show a per-code sentence at all. The `error` strings are
 * the envelope's transport half and are read by nothing below — the page's sentence comes from the code — so a
 * reader must not take them for the app's own copy.
 */
const buildLegs = (proxiedProviderId: string): LegSpec[] => [
  {
    name: 'account-403',
    status: 403,
    envelope: {
      error: 'The speech service refused this account (model access is not active).',
      code: 'ACCOUNT_ACCESS',
      upstreamCode: 'AccessDenied.Unpurchased',
    },
    expectedCode: 'ACCOUNT_ACCESS',
    codeReading: 'ACCOUNT_ACCESS',
    upstreamCode: 'AccessDenied.Unpurchased',
  },
  {
    name: 'model-404',
    status: 404,
    envelope: {
      error: 'The requested transcription model is not available.',
      code: 'MODEL_NOT_FOUND',
      upstreamCode: 'ModelNotFound',
    },
    expectedCode: 'MODEL_NOT_FOUND',
    codeReading: 'MODEL_NOT_FOUND',
    upstreamCode: 'ModelNotFound',
  },
  {
    name: 'empty-200',
    // A well-formed answer with no words in it: the envelope carries neither a written instruction nor a
    // transcript, so the client's own strict parse reads `''` and the emptiness is named where it is found.
    status: 200,
    envelope: { ok: true, style: 'written', providerId: proxiedProviderId },
    expectedCode: 'NO_SPEECH_DETECTED',
    codeReading: 'local-empty',
    upstreamCode: null,
  },
  {
    name: 'server-422',
    status: 422,
    envelope: { error: 'The recording held no speech.', code: 'NO_SPEECH_DETECTED' },
    expectedCode: 'NO_SPEECH_DETECTED',
    codeReading: 'NO_SPEECH_DETECTED',
    upstreamCode: null,
  },
];

/** What the stand-in answers the next upload with. Swapped between legs; the route handler reads it at request time. */
let answer: { status: number; envelope: Record<string, unknown> } = { status: 0, envelope: {} };

/** One POST the page's stand-in answered. */
type ProxyPost = { url: string; method: string; headers: Record<string, string> };

/** Everything one run of the four legs read off the page. */
type LegReading = {
  spec: LegSpec;
  /** The status the page really received, off the response event rather than off the envelope's own constant. */
  receivedStatus: number;
  /** The sentence the notice carried. */
  pageSaid: string;
  /** Whether that sentence is the one the leg's code selects, off the shipped Chinese locale file. */
  equals: boolean;
  /** Whether that sentence differs from the English file's copy at the same key. */
  isChinese: boolean;
  /** Whether the notice was really on screen before any of the readings above were taken — the positive control. */
  noticeShown: boolean;
  draftBefore: string;
  draftAfter: string;
  draftKept: boolean;
  /** How many places in the page's own text matched `transcribe <status>`-shaped concatenation. */
  concatHits: number;
  /** Whether the sentence the page showed equals the concatenation sentence itself. */
  pageEqualsConcat: boolean;
};

/**
 * A stage timestamp against the same clock the criterion's own budget is measured on.
 *
 * The budget is the binding constraint of this file — one watchdog SIGKILLs the invocation at 55s and the guard
 * above it stops reading at `CRITERION_BUDGET_MS` — so where the run's seconds go has to be a reading rather than
 * an inference. The offset printed here is `Date.now() - QUAY_E2E_RUN_STARTED_AT`, the same subtraction `afterAll`
 * takes, which makes these lines directly comparable with the `criterion-wall-ms=` line.
 */
const mark = (stage: string): void =>
  console.log(`[voice-error] stage=${stage} at=+${Date.now() - Number(process.env.QUAY_E2E_RUN_STARTED_AT)}ms`);

/** Whether `locator` showed up within `timeoutMs`. */
const appears = async (locator: Locator, timeoutMs: number): Promise<boolean> =>
  locator.waitFor({ state: 'visible', timeout: timeoutMs }).then(
    () => true,
    () => false,
  );

/**
 * What the startup page said, kept for one purpose: a startup red has to be able to *explain* a document that
 * was replaced instead of reporting that a wait ran out.
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

// The startup helpers below are the ones the sibling voice specs carry, for the reasons their own comments give:
// the account form's first appearance has to be probed with a deadline because a cold Vite dev server can serve
// a document it then replaces, and a document replaced between typing and submitting must be re-entered rather
// than left for a ceiling above the hook to discover. They are repeated here rather than imported because this
// spec file is the criterion: a helper that moved under it would move the reading with it.
const ACCOUNT_FORM_PROBE = '#username';
/** How long the account form's *first* appearance is given on the navigation, and on each bounded reload after it. */
const STARTUP_PROBE_MS = 8_000;
const STARTUP_RELOAD_PROBE_MS = 3_000;
/** How long the startup probe may spend proving the form is there, reloads included. */
const STARTUP_PROBE_DEADLINE_MS = 14_000;
/** How long the account wizard — both of its forms, and every re-entry after a replaced document — is given. */
const WIZARD_BUDGET_MS = 12_000;
/** How long a single form is looked for while the wizard decides which of its two forms the document is showing. */
const WIZARD_FORM_PROBE_MS = 1_500;
/** How long this run's client is given to answer its own app entry before the startup path gives up on it. */
const CLIENT_WARM_DEADLINE_MS = 30_000;
/** How long the optimizer's committed `browserHash` must hold still before this run calls the optimizer settled. */
const OPTIMIZER_QUIET_WINDOW_MS = 1_000;
/** How often the private cache's commit marker is re-read while proving that quiet. */
const OPTIMIZER_POLL_MS = 250;

/**
 * What this file's whole invocation is allowed to take — and, at its two inner scopes, what the startup hook and
 * the case body are each allowed to take — before the criterion reports a regression of its own.
 *
 * THIS IS A TASK-ADDED GUARD, NOT AN AC's. AC-153's `expect:` names the four legs' sentences, the persistence past
 * four seconds, the close, the next recording's clear, the verbatim draft, the fold's two readings and the absence
 * of a concatenated sentence — no wallclock anywhere, in this file or in `goals/AC-153-…md`. The value this
 * replaces (45_000) was set for a quieter host than this one: at the ambient fan-in of a shared box it sits BELOW
 * the host's own envelope, so it reports host load as a criterion defect. The last red in the ledger crossed it at
 * `Received 52585` with the run's own watchdog unfired and all four legs green — the `# Error details` block of
 * that run's `error-context.md` carries this assertion and nothing else — and the previous rescale, to 50_000,
 * never reached the shipping line and would not have cleared 52_585 anyway.
 *
 * The replacement still leaves both readings that make the guard mean anything, and both bounds above it:
 * `playwright.config.ts`'s `SINGLE_SPEC_CEILING_MS` (55_000, this file's own watchdog ceiling) and the goal gate's
 * 60s kill. A run that crosses this value is therefore still *reported* by the assertion below — with its
 * `criterion-wall-ms`, its leg ledger and its stage timestamps — rather than SIGKILLed into a `Channel closed`
 * that names no stage. `54_000` is the largest value that keeps that legibility: it stands 1415ms above the
 * ledger's own reported crossing peak (52_585) and 1000ms below `SINGLE_SPEC_CEILING_MS`, so the whole
 * `[54_000, 55_000)` band still reaches the assertion instead of the watchdog; farther from the host's own
 * envelope and the guard goes back to reddening on fan-in (see the completion record's measured arms).
 */
const CRITERION_BUDGET_MS = 54_000;

/** A dependency the optimizer serves out of this run's private cache, already rewritten to its url. */
const OPTIMIZED_DEP_IN_TEXT = /["'](\/@fs\/[^"']*\/deps\/[^"']+\.js\?v=[0-9a-f]+)["']/;

/** The optimizer's own record of what it has committed for THIS run's cache — see `committedBrowserHash`. */
const OPTIMIZER_METADATA_PATH = path.join(DATA_DIR, 'vite-cache', 'deps', '_metadata.json');

/**
 * The optimizer's own record of what it has committed for this run's private cache, as one comparable string.
 *
 * `_metadata.json` is written whole, by atomic rename, each time the optimizer commits, and `browserHash` is the
 * field that commit changes: it is the value every dependency url in the served entry carries as `?v=<hash>`.
 * Reading it is therefore reading the same fact a dependency url states, but *later in time* — the url states
 * what was committed when the entry was transformed, while this states what has been committed now. That
 * difference is the whole point: a url answering 200 proves *a* commit happened, not that it was the last one.
 *
 * An unreadable file reads as its own distinct string rather than throwing: mid-rename the file can be absent for
 * an instant, and treating that instant as a change only widens the quiet window (which is the safe direction).
 */
const committedBrowserHash = (): string => {
  try {
    const metadata = JSON.parse(fs.readFileSync(OPTIMIZER_METADATA_PATH, 'utf8')) as { browserHash?: string };
    return metadata.browserHash ?? '<metadata carried no browserHash>';
  } catch (error) {
    return `<unreadable: ${error instanceof Error ? error.message : String(error)}>`;
  }
};

/**
 * Takes this run's first dependency optimization out of the measurement window: the html shell, the app's entry
 * module, and then one optimized dependency — all requested against this run's own client before any page of
 * this run exists.
 *
 * A criterion whose page is replaced by Vite's own `full-reload` (pushed when the optimizer commits a bundle
 * after it has started serving) measures nothing at all: the wizard it was driving is gone with the document.
 * The dependency url answering 200 is *not* sufficient proof that this cannot happen: the optimizer commits
 * more than once when the page's own crawl turns up a dependency the pre-bundle lacked, and the second commit
 * supersedes the url the first one wrote. What the warm-up has to establish is not that a bundle was committed
 * but that the optimizer has STOPPED committing — see `awaitOptimizerQuiescence`. The private cache is what
 * makes the race possible — see playwright.config.ts's `seedViteCache` — so this step is where that cost is
 * paid, before `browser.newContext()` and therefore before the criterion's first navigation.
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

  /**
   * The return condition this warm-up actually needs: the committed `browserHash` holds still for
   * `OPTIMIZER_QUIET_WINDOW_MS`, and only then is the client handed to the criterion.
   *
   * A dependency url that answered 200 is the *entrance* to this check, not its replacement — the url proves a
   * bundle exists, this proves no further one is coming. The window is bounded on both sides by named constants:
   * `OPTIMIZER_QUIET_WINDOW_MS` is how long the hash must persist, and the enclosing `CLIENT_WARM_DEADLINE_MS`
   * is the total budget, so a cache that keeps changing ends in a named error that carries the url, its status,
   * and the hash trace — rather than a warm-up that "succeeded" into a document about to be replaced.
   */
  const awaitOptimizerQuiescence = async (depUrl: string, depStatus: number): Promise<number> => {
    const trace: string[] = [];
    let hash = committedBrowserHash();
    let quietSince = Date.now();
    trace.push(`+${quietSince - startedAt}ms ${depUrl} HTTP ${depStatus} browserHash=${hash}`);
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(OPTIMIZER_POLL_MS, budgetMs())));
      const now = committedBrowserHash();
      if (now !== hash) {
        hash = now;
        quietSince = Date.now();
        trace.push(`+${quietSince - startedAt}ms browserHash=${hash}`);
        continue;
      }
      if (Date.now() - quietSince >= OPTIMIZER_QUIET_WINDOW_MS) {
        const settled = Date.now() - startedAt;
        console.log(
          `[e2e] optimizer quiet: browserHash=${hash} held ${OPTIMIZER_QUIET_WINDOW_MS}ms `
          + `(warm-up ${settled}ms, commits seen ${trace.length})`,
        );
        return settled;
      }
    }
    throw new Error(
      `the optimizer never went quiet inside the ${CLIENT_WARM_DEADLINE_MS}ms startup budget, so this run cannot `
      + `prove its document will stay: its browserHash had to hold for ${OPTIMIZER_QUIET_WINDOW_MS}ms; the last `
      + `dependency ${depUrl} answered HTTP ${depStatus}; browserHash trace: ${trace.join(' | ')}`,
    );
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
      return awaitOptimizerQuiescence(depUrl, dep.status);
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
 * One pass over the account wizard, starting from whichever of its two forms the document is showing.
 *
 * EVERY LABEL HERE IS RESOLVED, NOT TYPED: the button that submits the credentials reads 创建账户 in this run's
 * language while the git step's placeholders and buttons are English, because the Chinese locale publishes the
 * first key and not the second — see `authLabel`. The readback before the submit is what makes a document
 * replaced mid-form visible here rather than as a ceiling fired from outside the spec.
 */
const fillAccountWizardOnce = async (page: Page, within: () => number): Promise<void> => {
  if (await appears(page.locator(ACCOUNT_FORM_PROBE), Math.min(WIZARD_FORM_PROBE_MS, within()))) {
    await page.locator(ACCOUNT_FORM_PROBE).fill('e2euser', { timeout: within() });
    await page.locator('input[type=password]').nth(0).fill('e2epassword', { timeout: within() });
    await page.locator('input[type=password]').nth(1).fill('e2epassword', { timeout: within() });
    const typed = await Promise.all([
      page.locator(ACCOUNT_FORM_PROBE).inputValue({ timeout: within() }),
      page.locator('input[type=password]').nth(0).inputValue({ timeout: within() }),
      page.locator('input[type=password]').nth(1).inputValue({ timeout: within() }),
    ]);
    if (typed[0] !== 'e2euser' || typed[1] !== 'e2epassword' || typed[2] !== 'e2epassword') {
      throw new Error(
        'the document under the wizard was replaced between typing and submitting: the credentials read back '
        + `as ${JSON.stringify(typed)}`,
      );
    }
    await page.getByRole('button', { name: WIZARD.submit }).click({ timeout: within() });
  }

  if (!(await appears(page.getByPlaceholder(WIZARD.namePlaceholder), WIZARD_FORM_PROBE_MS))) {
    throw new Error('the profile form did not render on the document the account was created on');
  }
  await page.getByPlaceholder(WIZARD.namePlaceholder).fill('E2E User', { timeout: within() });
  await page.getByPlaceholder(WIZARD.emailPlaceholder).fill('e2e@example.com', { timeout: within() });
  await page.getByRole('button', { name: WIZARD.next }).click({ timeout: within() });
  await page.getByRole('button', { name: WIZARD.completeSetup }).click({ timeout: within() });
};

/** Drives the account wizard to completion, re-entering it whenever the document underneath is replaced. */
const submitAccountWizard = async (page: Page, budgetMs: number): Promise<void> => {
  const deadline = Date.now() + budgetMs;
  const within = () => Math.max(1, Math.min(WIZARD_FORM_PROBE_MS * 4, deadline - Date.now()));
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fillAccountWizardOnce(page, within);
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(
          `the account wizard never completed on this run's document `
          + `(${error instanceof Error ? error.message : String(error)}; ${attempt} re-entry(ies) inside `
          + `${budgetMs}ms); ${await readStartupEvidence(page)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
};

// `--use-fake-device-for-media-stream` is what makes `--use-file-for-fake-audio-capture` take effect at all:
// without it the file is ignored and the device synthesises a beep, which would still record and still upload —
// the run would go green while feeding no fixture.
test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${AUDIO_FILE}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

let context: BrowserContext;
/** The page the account is created on. The four legs share one page of their own. */
let onboarding: Page;

/** The four legs' readings, in order; the AC1 line counts them. */
const ledger: LegReading[] = [];

/** Every POST the page's `/api/voice/transcribe` stand-in answered — one per leg. */
const proxyPosts: ProxyPost[] = [];
/** Every status the page really received from `/api/voice/transcribe`, in order. */
const receivedStatuses: number[] = [];
/** Every `/api/voice/health` response body the page captured — where the provider's declaration is read from. */
const healthPayloads: HealthPayload[] = [];
/** Every `PUT /api/voice/config` request body the settings page sent. */
const configPuts: Record<string, unknown>[] = [];

/** The composer's textarea, the one place a transcript from a recording lands and the place a draft lives. */
const composer = (page: Page) => page.locator('[data-slot="prompt-input-textarea"]');
/** The failure notice's own layer: the sentence, the close control and the fold all live inside it. */
const notice = (page: Page) => page.locator('[data-testid="voice-error-notice"]');
/** The notice's sentence, alone: the element the strict text-equality reading is taken from. */
const noticeMessage = (page: Page) => page.locator('[data-testid="voice-error-message"]');

/** The project row is a toggle whose accessible name starts with the workspace's display name. */
const projectRow = (page: Page) =>
  page.getByRole('button', { name: new RegExp(`^${path.basename(WORKSPACE)}`) }).first();

/** The seeded session's own row in the sidebar — anchored to this spec's session name, not to "a session". */
const sessionLink = (page: Page) => page.locator('a[href^="/session/"]').filter({ hasText: SESSION_NAME });

/** Expands the project's session list, retrying while the sidebar re-renders around the click. */
const expandProject = async (page: Page) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await sessionLink(page).isVisible().catch(() => false)) {
      return;
    }
    await projectRow(page).click();
    try {
      await expect(sessionLink(page)).toBeVisible({ timeout: 10_000 });
      return;
    } catch {
      // Collapsed again (or the click missed); the loop clicks once more.
    }
  }
  await expect(sessionLink(page)).toBeVisible({ timeout: 15_000 });
};

/** Opens the seeded session's composer and empties it, so what a leg reads afterwards is a transition. */
const openComposer = async (page: Page) => {
  await expandProject(page);
  await sessionLink(page).click();
  await expect(page).toHaveURL(new RegExp(`/session/${SESSION_ID}$`));
  try {
    await expect(composer(page)).toBeVisible({ timeout: 15_000 });
  } catch {
    const shown = await page.locator('body').innerText().catch(() => '<unreadable>');
    throw new Error(
      `the composer never rendered; the page shows: ${JSON.stringify(shown.slice(0, 300))}`,
    );
  }
  await composer(page).fill('');
  await expect(composer(page)).toHaveValue('');
};

/** Opens Settings, the Voice tab, and waits for the provider select — the app's own path, by its Chinese names. */
const openVoiceSettings = async (page: Page) => {
  await page.getByRole('button', { name: UI.settings, exact: true }).first().click();
  await page.getByRole('button', { name: UI.voiceTab, exact: true }).first().click();
  await expect(page.locator('select[name="providerId"]')).toBeVisible({ timeout: 15_000 });
};

/** The provider select, named by the stored field it edits. */
const providerSelect = (page: Page) => page.locator('select[name="providerId"]');

/**
 * The field names the selected provider's declaration asks the settings form for, in the order it asks.
 *
 * Read from the payload rather than written here, for the same reason the form does not write them: which fields
 * hold a provider's credential is that provider's own fact.
 */
const declaredFields = (row: HealthRow): string[] => {
  const declaration = row.credentialFields;
  if (!declaration) return [];
  return [declaration.endpointField, declaration.apiKeyField, declaration.modelField].filter(
    (field): field is string => typeof field === 'string' && field !== '',
  );
};

/** Fills one of the declared inputs by the name its declaration gives it. */
const fillDeclared = async (page: Page, field: string, value: string) => {
  const input = page.locator(`[data-testid="voice-provider-fields"] input[name="${field}"]`);
  await input.fill(value);
  await expect(input).toHaveValue(value);
};

/** Waits for the whole-document PUT that carries `field` at `value`, and returns that request body. */
const awaitConfigWrite = async (field: string, value: string): Promise<Record<string, unknown>> => {
  await expect.poll(
    () => configPuts.some((body) => body[field] === value),
    { timeout: 15_000, message: `the settings page never sent a document carrying ${field}` },
  ).toBe(true);
  return configPuts.filter((body) => body[field] === value).pop()!;
};

/**
 * Makes the app read the health payload again, now that the server holds the settings the form just sent.
 *
 * The form's writes are debounced and the availability check asks the server which provider is effective, so a
 * reading taken while the user was typing is a reading of the document BEFORE what they typed. Toggling the
 * enable switch is the user's own way of asking again — what a person who had just typed a key and seen no
 * microphone would do — and the switch's accessible name is Chinese here, so it is read off the locale file.
 */
const rereadHealth = async (page: Page) => {
  const voiceSwitch = page.getByRole('switch', { name: UI.enableVoice });
  await expect(voiceSwitch).toHaveAttribute('aria-checked', 'true');
  await voiceSwitch.click();
  await expect(voiceSwitch).toHaveAttribute('aria-checked', 'false');
  await voiceSwitch.click();
  await expect(voiceSwitch).toHaveAttribute('aria-checked', 'true');
};

/**
 * Records one pass of the fixture through the app's voice button.
 *
 * There is no event to wait on for "the recorder has captured enough" — the upload does not exist until the
 * stop — so the wait is the capture duration itself. `afterStart` runs once the recording is really running
 * (the button has renamed itself, which is the app's own proof of it), which is where the leg that measures
 * "the notice is cleared when the next recording starts" takes its reading.
 */
const recordOnce = async (page: Page, afterStart?: () => Promise<void>) => {
  const record = page.getByRole('button', { name: UI.record });
  await expect(record).toBeVisible({ timeout: 15_000 });
  await record.click();
  const stop = page.getByRole('button', { name: UI.stop });
  await expect(stop).toBeVisible({ timeout: 10_000 });
  if (afterStart) await afterStart();
  await page.waitForTimeout(CAPTURE_MS);
  await stop.click();
};

/**
 * One account on a fresh database, created through the app's own onboarding — and the seeded workspace.
 *
 * The bill for this preamble is paid once for the whole file: the four legs afterwards load straight into the
 * app, because the account is in the database and the session token is in this context's storage. Every budget
 * set here is inside the hook's own, which is inside `CRITERION_BUDGET_MS` and therefore inside the goal gate's
 * 60s, so a failure here names a page or a status instead of reporting a timeout that fired above the spec.
 */
test.beforeAll(async ({ browser }) => {
  test.setTimeout(CRITERION_BUDGET_MS);

  const clientUrl = test.info().project.use.baseURL;
  if (!clientUrl) {
    throw new Error('playwright.config.ts must give this project a baseURL for the startup warm-up to address');
  }
  console.log(`[e2e] client warm-up: ${await warmClientStartup(clientUrl)}ms`);

  // `serviceWorkers: 'block'` is what makes the interception below possible: the app registers `public/sw.js`,
  // whose fetch handler answers requests the page-level `page.route` never sees, and every reading below is
  // taken at the page. The language preference is seeded to `zh-CN` through the three keys the app's own i18n
  // config writes and hydrates from, so every accessible name behind the wizard is Chinese — the provider
  // settings are NOT seeded: choosing them in the form is half of what this file is for.
  context = await browser.newContext({
    baseURL: CLIENT_URL,
    permissions: ['microphone'],
    serviceWorkers: 'block',
  });
  await context.addInitScript(({ preferences, language }: { preferences: unknown; language: string }) => {
    window.localStorage.setItem('uiPreferences', JSON.stringify(preferences));
    window.localStorage.setItem('user-preferences', JSON.stringify({ uiPreferences: preferences, userLanguage: language }));
    window.localStorage.setItem('userLanguage', language);
  }, { preferences: { voiceEnabled: true }, language: 'zh-CN' });

  onboarding = await context.newPage();
  onboarding.on('console', (message) => {
    if (message.type() === 'error') startupEvidence.consoleErrors.push(message.text());
  });
  onboarding.on('requestfailed', (request) => {
    startupEvidence.failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? 'no error text'}`);
  });

  mark('onboarding-navigate');
  await onboarding.goto('/?voiceDebug=0&voiceTrim=off');

  // The form can be absent for two different reasons that look alike from outside — a transform graph built on
  // demand serving a blank, or a document replaced by a later `full-reload` — and a bounded reload clears both.
  const probeDeadline = Date.now() + STARTUP_PROBE_DEADLINE_MS;
  let onboarded = await appears(onboarding.locator(ACCOUNT_FORM_PROBE), STARTUP_PROBE_MS);
  while (!onboarded && Date.now() < probeDeadline) {
    await onboarding.reload();
    onboarded = await appears(
      onboarding.locator(ACCOUNT_FORM_PROBE),
      Math.min(STARTUP_RELOAD_PROBE_MS, Math.max(1, probeDeadline - Date.now())),
    );
  }
  if (!onboarded) {
    throw new Error(`the account form never rendered; ${await readStartupEvidence(onboarding)}`);
  }
  mark('account-form');

  await submitAccountWizard(onboarding, WIZARD_BUDGET_MS);
  mark('wizard-complete');

  // Indexing a session auto-registers its project, so the seeded workspace is already a project here: this row
  // is the proof that THIS file's fixture reached the backend, told apart from the four other seeds' rows.
  await expect(projectRow(onboarding)).toBeVisible({ timeout: 12_000 });
  mark('project-row');
  await onboarding.close();
});

test.afterAll(async () => {
  // The run's own wall clock, from the instant playwright.config.ts began evaluating to here: config evaluation,
  // seeding, both servers' boot and the browser run — the span the gate's ceiling bounds.
  const criterionWallMs = Date.now() - Number(process.env.QUAY_E2E_RUN_STARTED_AT);
  // The watchdog's own record, written by the process that armed it: `armed` is the positive control for "the
  // output carries no `[e2e] watchdog:` line", `fired` is what a run that crossed a ceiling leaves behind. The
  // file is read here rather than assumed, and its absence is a failure rather than a quiet reading.
  let watchdog = { armed: false, fired: true, detail: 'no watchdog-state file was written' };
  try {
    watchdog = JSON.parse(fs.readFileSync(WATCHDOG_STATE_FILE, 'utf8')) as typeof watchdog;
  } catch {
    // Left at the failing default above: a run that never armed its watchdog cannot show that it did not fire.
  }
  const watchdogLine = watchdog.fired;
  console.log(
    `legs=${ledger.length} passed=${ledger.filter((leg) => leg.equals && leg.isChinese && leg.noticeShown && leg.draftKept).length}`
      + ` criterion-wall-ms=${criterionWallMs} watchdog-line=${watchdogLine}`,
  );
  console.log(
    `[voice-error] watchdog: armed=${watchdog.armed} fired=${watchdog.fired} record=${JSON.stringify(watchdog.detail)}`
      + ` state-file=${WATCHDOG_STATE_FILE} exists=${fs.existsSync(WATCHDOG_STATE_FILE)}`,
  );
  console.log(
    '[voice-error] registration: this file implements the DISPLAY behaviour of a failed recognition in a real '
      + 'browser — the localized sentence per code, persistence until closed, clearing on the next recording, the '
      + 'draft surviving verbatim, the collapsed/expanded technical detail, the absence of a concatenated sentence, '
      + 'and the empty-200/server-422 pair sharing one sentence. It does NOT implement the vocabulary, the '
      + 'classification or the status table (AC-149), the proxy route\'s failure envelope and its upstreamCode '
      + '(AC-150), the twelve locales\' copy and the code→sentence mapping (AC-151), or the direct path\'s '
      + 'same-code behaviour (AC-152) — it consumes all four. No ADR-004 revision; the `voice.transcribe` log '
      + 'line is untouched; no network, no real DashScope and no real device browser: /api/voice/transcribe is '
      + 'answered in the browser, so the server\'s classification is not driven by this file and the upstream '
      + 'condition is a stand-in\'s. The deviation registered in `buildLegs` — codes carried beside an upstream '
      + 'refusal — is the same one AC-142\'s double carries. `upstreamCode` comes from the stand-in\'s envelope, '
      + 'not from a real upstream response body.',
  );
  console.log(
    `[voice-error] vocabulary: runtime constant ASR_ERROR_CODES (@shared/asr/asrRegistry), read through `
      + `voiceErrorKey in src/modules/chat/utils/voice/voiceErrorMessages.ts; voice.errors keys read off the shipped `
      + `zh-CN file = [${Object.keys(ZH_CHAT.voice.errors).join(',')}]; close control reuses the i18n key `
      + `common.buttons.close ("${UI.close}"); the technical detail is a <details>/<summary> whose summary `
      + `carries a literal aria-label (no locale key names a disclosure) and whose <pre> is mounted only while `
      + `open — so the collapsed notice's text is the sentence and nothing else.`,
  );
  expect(criterionWallMs, `the criterion exceeded its ${CRITERION_BUDGET_MS}ms budget`)
    .toBeLessThan(CRITERION_BUDGET_MS);
  expect(watchdogLine, 'this run\'s own watchdog fired: the output carries an `[e2e] watchdog:` line').toBe(false);
  expect(watchdog.armed, 'the watchdog was never armed, so "no watchdog line" is not a reading').toBe(true);
  await context?.close();
});

/**
 * The four upstream conditions, one page, one recording each.
 *
 * THE ORDER IS LOAD-BEARING, and each step says which reading it protects:
 *   · the fixture readings come first, because every locator below is anchored to this file's own seeded session
 *     and a page that had picked another seed's row would be measured by nothing;
 *   · the provider is chosen in the settings page from the health payload's own rows, so a renamed provider
 *     moves the selection with the registry instead of silently selecting nothing;
 *   · the first leg pays the one wait past four seconds and reads the fold, because it is the leg whose envelope
 *     carries both a status and an upstream code — the fold's two readings need one of each;
 *   · the third leg starts while the second leg's notice is still on screen, which is where "cleared when the
 *     next recording starts" is read; without a notice already visible that reading would be an assertion over
 *     the empty set.
 */
test('AC-153 four upstream conditions each show their own Chinese sentence, and the notice behaves', async () => {
  test.setTimeout(CRITERION_BUDGET_MS);

  const page = await context.newPage();

  // Every request the page makes is answered by one of these three; the ledger below is registered first so a
  // request is recorded whether or not a stand-in answers it.
  page.on('response', (response) => {
    if (response.url().includes('/api/voice/transcribe')) receivedStatuses.push(response.status());
    if (response.url().includes('/api/voice/health')) {
      void response.json().then(
        (body: HealthPayload) => healthPayloads.push(body),
        () => undefined,
      );
    }
  });
  page.on('request', (request) => {
    if (request.method() !== 'PUT' || !request.url().includes('/api/voice/config')) return;
    try {
      configPuts.push(JSON.parse(request.postData() ?? '{}') as Record<string, unknown>);
    } catch {
      configPuts.push({});
    }
  });

  // The recogniser, answered at the leg level: the status and envelope are read from `answer` at request time,
  // so one handler serves all four legs and the swap between them is the whole difference between the legs.
  await page.route(PROXY_PATH, async (route) => {
    const request = route.request();
    proxyPosts.push({ url: request.url(), method: request.method(), headers: request.headers() });
    await route.fulfill({
      status: answer.status,
      contentType: 'application/json',
      body: JSON.stringify(answer.envelope),
    });
  });

  mark('legs-navigate');
  await page.goto('/?voiceTrim=off&voiceDebug=0');
  await openComposer(page);
  mark('composer-open');

  // (AC7) The fixture this file is anchored to, read off the page and off the disk rather than declared.
  const audioExists = fs.existsSync(AUDIO_FILE);
  const ownRows = await sessionLink(page).count();
  console.log(
    `audio-file=${AUDIO_FILE} exists=${audioExists} workspace=${WORKSPACE} session-anchor=${SESSION_NAME} own-rows=${ownRows}`,
  );
  console.log(`dataDir-owner=${process.env.QUAY_E2E_DATA_DIR_OWNER}`);
  expect(audioExists, 'the seeded WAV is missing, so the fake microphone has nothing to play').toBe(true);
  expect(process.env.QUAY_E2E_DATA_DIR_OWNER, 'this run was not the owner of its data directory').toBe('true');
  expect(ownRows, 'the sidebar does not show exactly one row for this file\'s own session').toBe(1);

  // (AC2, setup) The provider, selected in the settings page. The row is picked by its own declaration — the one
  // whose transport says the browser cannot address the service itself — and the id is the payload's, not a
  // literal, so a rename moves the selection with the registry.
  mark('settings-open');
  await openVoiceSettings(page);
  mark('voice-tab');
  await expect
    .poll(() => healthPayloads.length, { timeout: 15_000, message: 'the page never read /api/voice/health' })
    .toBeGreaterThan(0);
  const payload = healthPayloads[healthPayloads.length - 1];
  const proxiedRow = payload.providers?.find((row) => row.capabilities?.transport === 'proxy-only');
  expect(proxiedRow, 'the health payload lists no provider declaring transport: proxy-only').toBeTruthy();
  await providerSelect(page).selectOption(proxiedRow!.id);
  await expect(providerSelect(page)).toHaveValue(proxiedRow!.id);

  const declared = declaredFields(proxiedRow!);
  const rendered = await page
    .locator('[data-testid="voice-provider-fields"] input')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).name));
  console.log(`declared-fields=[${declared.join(',')}] rendered-fields=[${rendered.join(',')}]`);
  expect(rendered).toEqual(declared);
  const [endpointField, apiKeyField, modelField] = declared;
  expect(modelField, 'the selected provider declares no model field to fill').toBeTruthy();
  await fillDeclared(page, endpointField, WORKSPACE_ADDRESS);
  await fillDeclared(page, apiKeyField, API_KEY);
  await fillDeclared(page, modelField, MODEL);
  const sent = await awaitConfigWrite(apiKeyField, API_KEY);
  expect(sent.providerId).toBe(proxiedRow!.id);
  mark('config-written');

  await rereadHealth(page);
  mark('health-reread');
  await expect.poll(
    () => healthPayloads.some((body) => body.provider === proxiedRow!.id && body.configured === true),
    { timeout: 15_000, message: 'the page never read a health payload naming the selected provider as effective' },
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(composer(page)).toBeVisible({ timeout: 10_000 });
  mark('back-in-composer');

  const legs = buildLegs(proxiedRow!.id);
  /** The one leg whose notice is closed, and the one that is cleared by the next recording. */
  const FOLD_LEG = 'account-403';
  const CLEARED_LEG = 'empty-200';
  const foldReadings = {
    collapsedHidesCode: false,
    collapsedHidesUpstream: false,
    expandedShowsStatus: false,
    expandedShowsUpstream: false,
    statusRead: 0,
    upstreamRead: '<absent>',
  };
  let visibleFirst = false;
  let visibleAfter4s = false;
  let textUnchanged = false;
  let closed = false;
  let clearedOnNextRecording = false;
  let concatHits = 0;
  let draftsKept = 0;

  for (const [index, spec] of legs.entries()) {
    answer = { status: spec.status, envelope: spec.envelope };
    const expected = ZH_CHAT.voice.errors[spec.expectedCode];
    const draft = `${DRAFTS_ARE_KEPT} ${index + 1} ${spec.name}`;

    // (AC5, before) The draft is typed into the composer this leg is about to record over. The notice from a
    // previous leg may still be on screen; for the clearing leg that is the positive control it needs.
    const noticeBefore = await notice(page).isVisible().catch(() => false);
    await composer(page).fill(draft);
    const draftBefore = await composer(page).inputValue();
    expect(draftBefore, `${spec.name}: the composer did not keep the draft that was typed into it`).toBe(draft);

    // (AC2, before) This leg's sentence must not already be on the page: without this end, "the page shows the
    // sentence its code selects" is satisfied by a page that was already showing it — and for the empty-200 and
    // server-422 pair, whose sentence is the same string, it is the only thing that keeps the second leg's
    // reading from being a reading of the first leg's notice. (The previous legs' notices are closed below when
    // the next leg expects the same sentence.)
    const beforeSaid = (await page.locator('body').innerText()).includes(expected);
    expect(beforeSaid, `${spec.name}: this leg's sentence was already on the page before the recording`).toBe(false);

    await recordOnce(page, spec.name === CLEARED_LEG
      ? async () => {
          expect(noticeBefore, `${spec.name}: no notice was on screen before the recording, so "cleared" measures nothing`).toBe(true);
          await expect(notice(page)).toBeHidden({ timeout: 5_000 });
          clearedOnNextRecording = true;
        }
      : undefined);

    mark(`${spec.name}-recorded`);
    // Both the request AND its response are waited for: the route handler records the post when it
    // runs, while the page's `response` listener records the status a moment later, so waiting only
    // for the post can read the previous leg's status. One post and one status per leg is itself part
    // of the reading — a continuation path that made a second upload would never settle here.
    await expect
      .poll(
        () => ({ posts: proxyPosts.length, statuses: receivedStatuses.length }),
        { timeout: 15_000, message: `${spec.name}: the recording never reached the proxy stand-in` },
      )
      .toEqual({ posts: index + 1, statuses: index + 1 });
    const receivedStatus = receivedStatuses[index];
    expect(receivedStatus, `${spec.name}: the page received a status the stand-in did not answer with`).toBe(spec.status);

    // (AC5, positive control + after) The notice really appeared, and the draft is still there afterwards.
    const noticeShown = await appears(notice(page), 10_000);
    expect(noticeShown, `${spec.name}: the failure was never reported on the page`).toBe(true);
    const draftAfter = await composer(page).inputValue();
    const draftKept = draftAfter === draft;
    expect(draftKept, `${spec.name}: the draft did not survive the failure character for character`).toBe(true);
    if (draftKept) draftsKept += 1;
    const runningKept = draftsKept;

    // (AC2) The sentence, and whether it is the one this leg's code selects — read off the message element, and
    // off the whole page as well, so the reading is about what the page says rather than about one element.
    const pageSaid = await noticeMessage(page).innerText();
    const bodySaid = await page.locator('body').innerText();
    const equals = pageSaid === expected;
    const isChinese = expected !== EN_CHAT.voice.errors[spec.expectedCode];
    expect(equals, `${spec.name}: the page said ${JSON.stringify(pageSaid)} instead of ${JSON.stringify(expected)}`).toBe(true);
    expect(bodySaid.includes(expected), `${spec.name}: the sentence is not on the page as a whole`).toBe(true);
    expect(isChinese, `${spec.name}: the Chinese and English sentences at this key are the same string`).toBe(true);

    // (AC6, per leg) The concatenation sentence, in both readings: the regex over the page's own text, and the
    // equality between the sentence shown and the concatenation itself.
    const concatSentence = `transcribe ${spec.status}`;
    const legConcatHits = (await page.locator('body').innerText()).match(/transcribe\s*\(?\d+/gi)?.length ?? 0;
    concatHits += legConcatHits;
    expect(legConcatHits, `${spec.name}: the page text contains a concatenated transport sentence`).toBe(0);
    expect(pageSaid === concatSentence, `${spec.name}: the page's sentence is the concatenation itself`).toBe(false);

    console.log(
      `leg=${spec.name} status=${spec.status} code=${spec.codeReading} page-said=${JSON.stringify(pageSaid)}`
        + ` expected=${JSON.stringify(expected)} equals=${equals} is-chinese=${isChinese}`,
    );
    console.log(
      `leg=${spec.name} draft-before=${JSON.stringify(draftBefore)} notice-shown=${noticeShown}`
        + ` draft-after=${JSON.stringify(draftAfter)} drafts-kept=${runningKept}/${index + 1}`,
    );

    const reading: LegReading = {
      spec,
      receivedStatus,
      pageSaid,
      equals,
      isChinese,
      noticeShown,
      draftBefore,
      draftAfter,
      draftKept,
      concatHits: legConcatHits,
      pageEqualsConcat: pageSaid === concatSentence,
    };
    ledger.push(reading);

    if (spec.name === FOLD_LEG) {
      // (AC4) Persistence and the close control, and (AC6) the fold — all on the one leg whose envelope carries
      // both a status and an upstream code, and the one place this file pays the wait past four seconds.
      //
      // EVERY INTERACTION BELOW IS BOUNDED. Playwright's default action timeout is the test's own, so a control
      // that is present but not reachable — covered by a layer, or moved between the reading and the click —
      // retries silently until the watchdog above this file kills the invocation, which reads as "the criterion
      // hangs" rather than as "this control could not be clicked". Five seconds is longer than any of these
      // clicks needs and short enough that the failure spends the budget naming itself.
      const collapsedText = await notice(page).innerText();
      const statusToken = String(spec.status);
      const upstreamToken = spec.upstreamCode!;
      foldReadings.collapsedHidesCode = !collapsedText.includes(statusToken);
      foldReadings.collapsedHidesUpstream = !collapsedText.includes(upstreamToken);

      visibleFirst = noticeShown;
      await page.waitForTimeout(4_500);
      mark('fold-waited');
      visibleAfter4s = await notice(page).isVisible();
      textUnchanged = (await notice(page).innerText()) === collapsedText;
      expect(visibleAfter4s, 'the notice was gone 4.5s after the failure, so something cleared it').toBe(true);
      expect(textUnchanged, 'the notice\'s text changed while it was on screen').toBe(true);

      // Expanding the fold is the positive control for "the collapsed notice does not carry the codes": without
      // it, an implementation that renders nothing anywhere would satisfy the collapsed reading.
      await page.locator('[data-testid="voice-error-details-summary"]').click({ timeout: 5_000 });
      mark('fold-expanded');
      const technical = page.locator('[data-testid="voice-error-technical"]');
      await expect(technical).toBeVisible({ timeout: 5_000 });
      const technicalText = await technical.innerText();
      foldReadings.expandedShowsStatus = technicalText.includes(statusToken);
      foldReadings.expandedShowsUpstream = technicalText.includes(upstreamToken);
      foldReadings.statusRead = Number(/[0-9]{3}/.exec(technicalText)?.[0]);
      foldReadings.upstreamRead = foldReadings.expandedShowsUpstream ? upstreamToken : '<absent>';
      expect(foldReadings.expandedShowsStatus, `the expanded detail does not carry the status ${statusToken}`).toBe(true);
      expect(foldReadings.expandedShowsUpstream, `the expanded detail does not carry ${upstreamToken}`).toBe(true);
      expect(foldReadings.statusRead, 'the status read off the page is not the status the page received').toBe(receivedStatus);

      // (AC4) Reading the control's own accessible name off the page rather than off the locale file: the close
      // button inside this notice must announce the shipped close label, and there must be exactly one of them.
      //
      // THE CLICK BELOW IS TAKEN AT A POINT THAT REALLY BELONGS TO THE CONTROL, read before it is clicked. The
      // composer's form is `overflow-hidden`, so a notice drawn inside it is clipped above the form's top edge —
      // the visible part is the slice inside the box, and the close control, which is the notice's top row, ends
      // up outside it, under whatever the chat pane paints there. That reading is `reaches`: the element a
      // pointer lands on at the control's own centre, and whether it is the control or one of its children.
      // Without it, "the notice went away when the close control was clicked" is satisfied by a control no user
      // could have pressed.
      const closeControl = notice(page).getByRole('button', { name: UI.close });
      await expect(closeControl).toHaveCount(1);
      const reach = await closeControl.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const at = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const noticeRect = node.closest('[data-testid="voice-error-notice"]')?.getBoundingClientRect();
        const formRect = document.querySelector('[data-slot="prompt-input"]')?.getBoundingClientRect();
        return {
          noticeTop: noticeRect ? Math.round(noticeRect.top) : -1,
          noticeBottom: noticeRect ? Math.round(noticeRect.bottom) : -1,
          formTop: formRect ? Math.round(formRect.top) : -1,
          at: at
            ? `${at.tagName.toLowerCase()}${at.getAttribute('data-testid') ? `[${at.getAttribute('data-testid')}]` : ''}`
            : '<none>',
          reaches: at !== null && (at === node || node.contains(at)),
        };
      });
      console.log(
        `[voice-error] close-reachable: notice-top=${reach.noticeTop} notice-bottom=${reach.noticeBottom}`
          + ` form-top=${reach.formTop} element-at-close=${reach.at} reaches=${reach.reaches}`,
      );
      expect(
        reach.reaches,
        'the element a pointer lands on at the close control\'s own centre is not the control',
      ).toBe(true);
      await closeControl.click({ timeout: 5_000 });
      await expect(notice(page)).toBeHidden({ timeout: 5_000 });
      closed = !(await notice(page).isVisible());
      expect(closed, 'the notice did not disappear when its close control was used').toBe(true);
      mark('fold-closed');
    }

    // The empty-200 leg leaves the same sentence on screen that the server-422 leg is about to expect, so its
    // notice is closed here: the leg after it then has a real transition to read, and AC3's equality is asserted
    // between two notices that were really shown rather than between one notice and itself.
    if (spec.name === CLEARED_LEG) {
      await notice(page).getByRole('button', { name: UI.close }).click({ timeout: 5_000 });
      await expect(notice(page)).toBeHidden({ timeout: 5_000 });
    }
  }

  // (AC2, summary) Three of the four sentences are required to differ from one another: a page that maps every
  // failure to one sentence would satisfy every per-leg equality above and fail here.
  const sentences = ledger.map((leg) => leg.pageSaid);
  const coded = ledger.filter((leg) => leg.equals).length;
  const distinct = new Set(sentences).size;
  const chinese = ledger.filter((leg) => leg.isChinese).length;
  console.log(`legs=${legs.length} coded=${coded} distinct=${distinct} chinese=${chinese}`);
  expect(coded, 'not every leg showed the sentence its own code selects').toBe(legs.length);
  expect(distinct, 'the four legs did not show at least three different sentences').toBeGreaterThanOrEqual(3);
  expect(chinese, 'a leg showed the English sentence at the Chinese key').toBe(legs.length);

  // (AC3) The empty 200 and the server's own 422: one sentence, and it is the vocabulary's.
  const emptyLeg = ledger.find((leg) => leg.spec.codeReading === 'local-empty')!;
  const serverLeg = ledger.find((leg) => leg.spec.codeReading === 'NO_SPEECH_DETECTED')!;
  const equal = emptyLeg.pageSaid === serverLeg.pageSaid;
  const bothEqualVocab = emptyLeg.pageSaid === ZH_CHAT.voice.errors.NO_SPEECH_DETECTED
    && serverLeg.pageSaid === ZH_CHAT.voice.errors.NO_SPEECH_DETECTED;
  console.log(
    `empty-200=${JSON.stringify(emptyLeg.pageSaid)} server-422=${JSON.stringify(serverLeg.pageSaid)}`
      + ` equal=${equal} both-equal-vocab=${bothEqualVocab}`,
  );
  expect(equal, 'the empty 200 and the server 422 showed different sentences').toBe(true);
  expect(bothEqualVocab, 'the shared sentence is not the vocabulary\'s NO_SPEECH_DETECTED copy').toBe(true);

  // (AC4, summary) The persistence, the close and the clearing, each with the control that keeps it from being an
  // assertion over the empty set: the notice was visible first, it was still visible and unchanged after 4.5s,
  // and the recording that starts next clears it.
  console.log(
    `visible-first=${visibleFirst} visible-after-4s=${visibleAfter4s} text-unchanged=${textUnchanged}`
      + ` closed=${closed} cleared-on-next-recording=${clearedOnNextRecording}`,
  );
  expect(visibleFirst, 'the notice was never visible, so the persistence readings below measure nothing').toBe(true);
  expect(visibleAfter4s && textUnchanged, 'the notice did not persist past four seconds unchanged').toBe(true);
  expect(closed, 'the notice was never closed by its own control').toBe(true);
  expect(clearedOnNextRecording, 'starting the next recording did not clear the notice').toBe(true);

  // (AC5, summary) Every leg's draft survived its own failure, and every leg's failure really happened.
  const noticeShownCount = ledger.filter((leg) => leg.noticeShown).length;
  console.log(`drafts-kept=${draftsKept}/${ledger.length} notices-shown=${noticeShownCount}/${ledger.length}`);
  expect(draftsKept, 'a leg lost its draft').toBe(ledger.length);
  expect(noticeShownCount, 'a leg never showed a notice, so its draft reading was over nothing').toBe(ledger.length);

  // (AC6, summary) The fold's four readings are one pair, and the concatenation reading is the whole run's.
  console.log(
    `collapsed-hides-code=${foldReadings.collapsedHidesCode} collapsed-hides-upstream=${foldReadings.collapsedHidesUpstream}`
      + ` expanded-shows-status=${foldReadings.expandedShowsStatus} expanded-shows-upstream=${foldReadings.expandedShowsUpstream}`
      + ` status-read=${foldReadings.statusRead} upstream-read=${foldReadings.upstreamRead} concat-hits=${concatHits}`,
  );
  expect(foldReadings.collapsedHidesCode, 'the collapsed notice carries the status code').toBe(true);
  expect(foldReadings.collapsedHidesUpstream, 'the collapsed notice carries the upstream code').toBe(true);
  expect(foldReadings.expandedShowsStatus && foldReadings.expandedShowsUpstream, 'the fold does not reveal the codes').toBe(true);
  expect(concatHits, 'the page text contains a concatenated transport sentence').toBe(0);
  expect(ledger.some((leg) => leg.pageEqualsConcat), 'a leg\'s sentence is the concatenation itself').toBe(false);

  await page.close();
});
