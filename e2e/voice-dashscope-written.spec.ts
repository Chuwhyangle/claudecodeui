import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { BrowserContext, Locator, Page, Request, Response } from '@playwright/test';

// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data dir),
// recording through the app's own voice button. The recorder is the browser's own: Chromium is launched with a
// fake audio device whose samples come from the WAV playwright.config.ts wrote before the servers booted, so
// `getUserMedia` hands `MediaRecorder` a real stream and the app's own hook encodes what it hears.
//
// What this file adds over the two voice specs beside it: those point the voice settings at a real local HTTP
// recogniser, and the settings page is never touched — they seed the legacy `voiceConfig` blob. Here the
// SETTINGS PAGE is the only way the provider is chosen and the credential is typed, and the recogniser is
// intercepted in the browser instead of stood up on a socket. Both differences are the reading this file
// exists for: "the settings page really selects a provider and really sends the user's own address and key
// with it, and the recording then takes the route that provider's own declaration names".
//
// INTERCEPTION VS A REAL SERVICE, said once because it bounds every claim below: `page.route` answers
// `/api/voice/transcribe` and the aliyuncs host in the browser. Nothing here is the real DashScope service,
// and no request leaves the machine. What IS real is everything on this side of the interception: the
// settings form, the whole-document PUT the server stores, the health payload the client routes on, and the
// upload the capture chain actually produced — which is what makes "the page went through the proxy and never
// touched the workspace host" a statement about the app rather than about the harness.
//
// THE TWO COUNTS THAT MAKE EACH OTHER CREDIBLE: the DashScope leg reads zero requests to the aliyuncs host and
// the control leg — a provider the payload declares as directly connected, given the SAME address — reads at
// least one. A harness that counted nothing anywhere, or hardcoded the zero, could not produce the second.

const DATA_DIR = process.env.QUAY_E2E_DATA_DIR!;
const CLIENT_URL = `http://127.0.0.1:${process.env.QUAY_E2E_CLIENT_PORT}`;
const WORKSPACE = path.join(DATA_DIR, 'voice-dashscope-workspace');
const SESSION_ID = 'e2e-voice-dashscope';
const SESSION_NAME = 'voice-dashscope';
/** Where the fake microphone reads its samples from; the config wrote it before the browser was launched. */
const AUDIO_FILE = process.env.QUAY_E2E_VOICE_DASHSCOPE_AUDIO!;

/**
 * The id the criterion reads off the request header verbatim.
 *
 * It is NOT how the leg picks its provider — the selection is made from the health payload's own rows (see
 * `proxyRow`), so a rename would move the selection with the registry and red this assertion rather than
 * silently selecting nothing. This constant is the criterion's literal: the header the proxy hop carries.
 */
const PROXIED_PROVIDER_ID = 'dashscope-omni';

/**
 * The address typed into the provider's own endpoint field, and the one the served webm is uploaded to.
 *
 * It is a workspace hostname of the shape that provider's declaration accepts (`<workspace>.<region>.maas.
 * aliyuncs.com`, https, no port), which matters because every settings save re-validates the stored address
 * against that rule: an address the rule refuses is a save the server answers 400 to, and the leg would then
 * be recording through whatever provider was stored before.
 */
const WORKSPACE_ADDRESS = 'https://voice-e2e-check.cn-hangzhou.maas.aliyuncs.com';
/** The credential typed into the provider's own key field. A sentinel, and the one string that must travel as typed. */
const API_KEY = 'sk-e2e-dashscope-4f19c7a2';
/** The per-user model typed into the provider's own model field. */
const MODEL = 'qwen3.8-omni-flash';

/**
 * The written instruction the transcribe double answers the DashScope leg with.
 *
 * Deliberately unlike anything else in this file's fixture: the seeded transcript says "open the composer for
 * the provider check", the seeded file says "notes kept in the workspace…", and the draft the refusal leg
 * types is its own sentence. A composer assertion satisfied by any of them would be satisfied by a leg that
 * transcribed nothing, so the sentence asserted on is one no other part of this run can produce.
 *
 * It is also an ordinary lowercase sentence with no dotted name in it: the composer's transcript is repaired
 * against the project's own identifiers before it lands, and a name the repair might rewrite would put a
 * second, unrelated transformation between the recogniser and the assertion.
 */
const WRITTEN_INSTRUCTION = 'draft the paragraph as one written instruction for the coding agent';

/**
 * The written-style envelope the double answers the DashScope leg with.
 *
 * The shape is the one the task's proposal fixes: the transcription envelope the proxy path returns, with the
 * written-style fields beside the text. The client reads `text` and nothing else (`parseTranscriptionResponse`,
 * strict), so the extra fields are this envelope's own metadata rather than a second input — the same reason
 * they are pinned: an envelope without them would not be the written instruction's answer.
 */
const WRITTEN_ENVELOPE = {
  ok: true,
  text: WRITTEN_INSTRUCTION,
  style: 'written',
  transformations: ['written-style'],
  providerId: PROXIED_PROVIDER_ID,
};

/**
 * The refusal the double answers the second leg with, and the code the page's sentence is chosen by.
 *
 * The transport sentence (`error`) is not what the page shows any more and this file asserts on it nowhere: the
 * composer renders the localized sentence the code selects (see `REFUSAL_COPY`), and the code itself belongs to
 * the folded technical-detail line another criterion owns. The field stays because it is part of the envelope
 * the real proxy answers a refusal with, and a double that dropped it would be answering a shape the app never
 * meets.
 *
 * WHAT IS AND IS NOT FAITHFUL HERE, stated because the difference is deliberate and a reader would otherwise
 * have to reconstruct it. The upstream condition is a credential the service refused, and the app's own
 * classification of that condition is `UNAUTHORIZED` — `PROVIDER_ERROR_STATUS` maps it to 502, which is what
 * this status is. The message is the proxy's own sentence for it, character for character
 * (`backendFailure(401|403)`). The CODE is where this double is one step outside the app: the real route
 * republishes a code only for the refusals that happen BEFORE the upstream is called (the container and size
 * gates), so an upstream refusal reaches the browser as a message with no code and the page would read
 * "transcribe 502". The criterion asks that a refused recognition be recognisable as the refusal it is, and the
 * app's recognition is the code the seam classified it with, so this double supplies the code the seam itself
 * holds for this classification. The deviation is registered in this file's own output rather than left for a
 * reader to find.
 */
const REFUSAL_ENVELOPE = {
  error: 'Voice backend rejected the request (check the API key).',
  code: 'UNAUTHORIZED',
};
const REFUSAL_STATUS = 502;

/**
 * The shipped English sentences for the refusals this leg has to tell apart, read off the disk at run time.
 *
 * WHY THIS FILE DOES NOT CARRY THE SENTENCE ITSELF. The copy a refusal gets is chosen from its code, so the
 * string this leg has to expect is a function of the locale file and of the code rather than of this spec — and
 * a copy restated here is one that stops moving when the locale does. That is not hypothetical for THIS leg: it
 * was pinned to the transport sentence plus the bare code, a later change replaced the displayed sentence with a
 * localized one, and the expectation stayed behind and reddened while the behaviour under test kept working.
 * Read here instead, an edit to `/src/modules/i18n/locales/en/chat.json` moves the assertion with it.
 *
 * THREE SENTENCES, AND WHY ALL THREE. `REFUSAL_COPY` is the one this leg's own envelope earns, indexed by the
 * envelope's code so that the key is named once (in the envelope) and not twice. The other two are the ones a
 * leg must not be reading: `NO_SPEECH_DETECTED` is the class of copy a chain that reached no answer at all
 * would show, and `unknown` is the fallback every failure outside the vocabulary lands on. "Some error is on
 * screen" is satisfiable by either; the classification is what this leg is about, so all three are printed and
 * taken apart.
 *
 * The shipped directory is the right one because the interface language is: `beforeAll`'s `addInitScript` pins
 * the UI language to `en`, so the sentence the app renders and the sentence read here come from the same file.
 */
const EN_VOICE_ERRORS = (
  JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), 'src/modules/i18n/locales/en/chat.json'), 'utf8'),
  ) as { voice: { errors: Record<string, string> } }
).voice.errors;
/** The sentence the refusal leg's own envelope selects — the code is read off the envelope rather than restated. */
const REFUSAL_COPY = EN_VOICE_ERRORS[REFUSAL_ENVELOPE.code];
/** The "no answer reached this recording" sentence, which the refusal leg must NOT be showing. */
const NO_SPEECH_COPY = EN_VOICE_ERRORS.NO_SPEECH_DETECTED;
/** The fallback sentence an unnamed failure lands on, which the refusal leg must NOT be showing either. */
const UNKNOWN_COPY = EN_VOICE_ERRORS.unknown;

/**
 * The draft the refusal leg types before it records.
 *
 * Read back before the recording and compared character for character after it: the claim is about the SAME
 * string surviving, which is only a reading if the leg knows the string it started from. Distinct from every
 * other sentence in the run, so a composer that took the recogniser's text instead could not pass.
 */
const DRAFT = 'keep this draft through a refused recognition attempt 7f2a';

/**
 * How long each leg holds the recorder open.
 *
 * `useVoiceInput` refuses to upload a blob under 800 bytes ("Recording too short"), which this clears by an
 * order of magnitude, and the trim is switched off on every leg — so the bytes uploaded are the bytes the
 * recorder produced, with no second codec in between.
 *
 * ONE CAPTURE IS ONE ATTEMPT, NOT A GUARANTEE, and treating it as one is the defect this file's recording step
 * was fixed for: the app sends NOTHING when a capture ends with no audio frames, so a fixed window that came up
 * empty left the leg waiting out its whole upload predicate for a request the app was never going to make. See
 * `recordUntil`, which replays the capture instead of trusting this one.
 */
const CAPTURE_MS = 1_500;

/**
 * How long one attempt's own capture is given to show its upload before the step records again.
 *
 * The upload a capture DOES produce is issued by the stop click and answered by this leg's stand-in in this same
 * process, so the question "did frames reach the wire" is settled within a few hundred ms of the stop — while a
 * capture that produced no frames settles it by sending nothing at all, ever. This window is deliberately
 * several times the cost of the answer so that a host under load reads as slow rather than as empty.
 */
const POST_OBSERVE_MS = 4_000;

/**
 * The whole recording-evidence step's own ceiling, replay included — DERIVED FROM THE LEG'S OWN BUDGET.
 *
 * Each recording leg sets its own `test.setTimeout` — 45_000 for the refusal leg, 50_000 for the written one —
 * and everything else the leg does inside that budget is already bounded by this file: the preamble before the
 * recording (openLeg's navigation, the composer open, the health poll) is at most 15_000 (that poll's own
 * timeout) and the assertions after it (the refusal sentence's 10_000 visibility wait, the composer readbacks)
 * at most 12_000. The step therefore gets `45_000 - 15_000 - 12_000 = 18_000` of the smallest leg budget, and is
 * set below that — 12_000 — which also keeps one replay of a slow attempt inside the goal gate's 60s wall
 * alongside the other leg and the file's shared preamble.
 */
const RECORD_EVIDENCE_BUDGET_MS = 12_000;

/** The proxy hop the app is expected to take for a provider declaring `transport: 'proxy-only'`. */
const PROXY_PATH = /\/api\/voice\/transcribe/;
/** The browser-side stand-in for the provider's own host, so a request that really goes out is answered rather than left hanging. */
const ALIYUNCS_URL = /aliyuncs\.com/;

/**
 * Chromium's fake audio device, fed from the WAV playwright.config.ts wrote before the servers booted.
 *
 * `--use-fake-device-for-media-stream` is what makes `--use-file-for-fake-audio-capture` take effect at all:
 * without it the file is ignored and the device synthesises a beep, which would still record and still
 * transcribe — the run would go green while testing no fixture.
 */
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

/**
 * One row of the health payload, as much of it as this file reads.
 *
 * `credentialFields` is the provider's own declaration of WHICH settings fields hold its address, key and
 * model — republished by the server for the settings form, and read here for the same reason the form reads
 * it: so this file renders no table of its own. `capabilities.transport` is the declaration the routing under
 * test follows.
 */
type HealthRow = {
  id: string;
  label: string;
  configured: boolean;
  capabilities?: { transport?: string };
  credentialFields?: { endpointField: string; apiKeyField: string; modelField?: string };
};

type HealthPayload = { configured?: boolean; provider?: string; providers?: HealthRow[] };

/** One POST the leg's own proxy stand-in answered. */
type ProxyPost = { url: string; method: string; headers: Record<string, string> };

/**
 * One leg's readings off the shared document.
 *
 * The TRAFFIC counters below are per leg, because each is a count ABOUT ONE LEG: the proxy stand-in's own
 * counter answers "did this leg upload once", the ledger answers "did this leg touch that host". Counters
 * shared across the file would make the second leg's reading a function of the first leg's, which is exactly
 * the coupling the two legs are meant to be compared without.
 *
 * The HEALTH ledger is the exception, and its field says why: it is the one reading that is about the PAGE
 * rather than about a leg's traffic.
 */
type Leg = {
  name: string;
  page: Page;
  /** Every POST this leg's `/api/voice/transcribe` stand-in answered — the leg's own counter. */
  proxyPosts: ProxyPost[];
  /** Every request this leg's aliyuncs stand-in answered, method and URL. */
  aliyuncsHits: string[];
  /** Every host ending in `aliyuncs.com` this leg's `page.on('request')` ledger saw. */
  aliyuncsLedger: string[];
  /** The shared document's health readings — `documentHealth`, not a per-leg slice (see there). */
  health: HealthPayload[];
  /** Every `PUT /api/voice/config` REQUEST body this leg's settings page sent. */
  configPuts: Record<string, unknown>[];
  /** Every `PUT /api/voice/config` RESPONSE body the server answered — the readback, masked. */
  configReadbacks: Record<string, unknown>[];
  /** What this leg's stand-in answers a transcription with. */
  answer: 'written' | 'refused';
  /** The `voiceDebugFlags` this leg's page had after it loaded, read off its own storage. */
  flags: string;
};

/**
 * Every `/api/voice/health` body the shared document has read, in order — the FILE's ledger, not one leg's.
 *
 * Shared, unlike the traffic counters above, and for the same reason the document is shared: a health reading
 * is the page's own knowledge of which provider is effective, and that knowledge lives on the document across
 * the legs rather than at any leg's edge. The refusal leg runs on the very document the written leg configured,
 * so the reading that leg's settings trip produced is a reading of THIS page — keeping one ledger is what makes
 * the refusal leg's precondition ("the page has read health naming the saved provider as effective") true
 * without a second document, which is the whole point of running both legs on one page. That a read predates
 * the leg which asserts on it is not a weaker reading but the accurate one: the page, not the leg, is what
 * knows the provider.
 */
const documentHealth: HealthPayload[] = [];

/** Whether `locator` showed up within `timeoutMs`. */
const appears = async (locator: Locator, timeoutMs: number): Promise<boolean> =>
  locator.waitFor({ state: 'visible', timeout: timeoutMs }).then(
    () => true,
    () => false,
  );

/**
 * The selector this spec's startup path probes for: the account form's own username field.
 *
 * Named rather than inlined at the probe for one reason: the bounded-failure variant has to be able to point
 * *this* — and nothing else — at a selector that cannot exist, and watch the probe end inside its own budget.
 * The wizard below fills the same field, so a literal at the probe would have put the sentinel in both places.
 */
const ACCOUNT_FORM_PROBE = '#username';

/** How long the account form's *first* appearance is given on the navigation, and on each bounded reload after it. */
const STARTUP_PROBE_MS = 8_000;
const STARTUP_RELOAD_PROBE_MS = 3_000;

/**
 * How long the startup probe may spend proving the form is there, reloads included.
 *
 * A deadline rather than a reload count, because it is the *sum* that has to stay inside the criterion's own
 * wall clock: the bounded-failure reading asks that a probe which cannot succeed ends the run in under 30s,
 * and that run pays the config evaluation, both servers' boot and the browser launch before the probe's first
 * attempt even starts. Counting reloads leaves that head-room to chance; a deadline spends it.
 */
const STARTUP_PROBE_DEADLINE_MS = 14_000;

/**
 * How long the account wizard — both of its forms, and every re-entry after a replaced document — is given.
 *
 * Its own budget rather than the hook's, so exhausting it is this spec's error and not a timeout fired from
 * outside. The three are ordered, each strictly inside the next: this budget and the probe's deadline are
 * inside the hook's, and the hook's is inside the goal gate's 60s.
 */
const WIZARD_BUDGET_MS = 12_000;

/** How long a single form is looked for while the wizard decides which of its two forms the document is showing. */
const WIZARD_FORM_PROBE_MS = 1_500;

/**
 * How long this run's client is given to answer its own app entry before the criterion's startup path gives
 * up on it.
 *
 * Not a guess at the slow case, but the bound that turns "the client never came up" into this spec's own red:
 * the run already has two ceilings above it (the hook's own budget, then the goal gate's 60s), and both are
 * *outside* the spec — an unbounded wait inside `beforeAll` would be reported by whichever of them fired
 * first, naming neither the url nor the status.
 */
const CLIENT_WARM_DEADLINE_MS = 30_000;

/** A dependency the optimizer serves out of this run's private cache, already rewritten to its url. */
const OPTIMIZED_DEP_IN_TEXT = /["'](\/@fs\/[^"']*\/deps\/[^"']+\.js\?v=[0-9a-f]+)["']/;

/**
 * Takes this run's first dependency optimization out of the measurement window: the html shell, the app's
 * entry module, and then one optimized dependency — all requested against this run's own client before any
 * page of this run exists.
 *
 * The dependency request is the one that carries the proof, and it is why the step is not just "warm the
 * cache". The imports of a transformed module are already rewritten to this run's own
 * `/@fs/<cacheDir>/deps/<dep>.js?v=<hash>` urls, and that url only answers 200 once the optimizer has
 * committed the bundle: while the bundle is still being built the request is held, and a url carrying a hash
 * from a superseded run is exactly what a page receives `504 Outdated Optimize Dep` for. Vite reacts to a
 * (re)optimization committed after it has started serving by pushing `full-reload` to every connected client
 * (`node_modules/vite/dist/client/client.mjs`'s `case "full-reload"`), which replaces the document whole — the
 * way this criterion lost its page *after* the account form had already rendered. So a 200 there means the
 * page below will not race the optimizer, and the wizard the criterion drives will be driven on the document
 * it was navigated to.
 *
 * The private cache is what makes the race possible at all, and it is also why the seed in
 * `playwright.config.ts` is not enough on its own: the seed is only usable when the shared cache was written
 * by *this* root, and when it is not, the private directory is built from scratch *while the server is
 * already answering* — inside the measurement window. This step is where that build is paid.
 *
 * Why the warm-up lives here rather than in `playwright.config.ts`'s `globalSetup`, which is where this
 * defect's proposal put it: Playwright resolves every `globalSetup` entry as a *script* — `resolveScript()`
 * turns it into a path and the file must default-export the function — so an inline warm-up is neither
 * type-legal nor loadable, and this task's write surface allows no new file. `beforeAll`, before
 * `browser.newContext()`, is the earliest point inside the criterion's own startup path, and it is strictly
 * before any page exists — the same requests the page would have made, made first.
 *
 * Every step is bounded, including each request: a client that accepts the connection and then never answers
 * fails here, by name, with the url and the status, rather than waiting out a timeout further up.
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

  // The proof: a dependency url current for this run — re-read from the entry each attempt, because the hash a
  // url carries is the one its writer committed, and the entry is where the current one is written.
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

/**
 * One pass over the account wizard, starting from whichever of its two forms the document is showing.
 *
 * The readback before the submit is the point of the pass. This run's dependency pre-bundle can be committed
 * by Vite after the servers have begun answering, and Vite answers that by pushing `full-reload` to every
 * connected client — the document is replaced whole and the SPA's state, including a half-filled form, is
 * gone. The startup probe above covers the form's *first* appearance and nothing after it, so a replacement
 * landing here used to be invisible: the click submitted a form that no longer had anything in it (or no
 * longer existed), `John Doe` never appeared, and the run then died in whichever ceiling was above it.
 * Reading the values back out of the document *before* the submit is what makes the replacement visible
 * while it is still cheap, and the caller re-enters the pass on whatever document is current.
 *
 * A replacement that lands after `Create Account` is resumed rather than redone: the account exists by then,
 * so the pass looks for the profile form first and only falls back to the credentials form when the profile
 * step is not what the document is showing. A replacement landing between `Next` and `Complete Setup` is the
 * one point this pass does not resume from; it ends as the caller's bounded error, with the page and console
 * evidence, rather than as a hook timeout.
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
    await page.getByRole('button', { name: 'Create Account' }).click({ timeout: within() });
  }

  // The profile step, on the document this pass is holding. Its absence after the credentials were submitted
  // is the other half of the same hazard: the form the click was meant to produce never arrived.
  if (!(await appears(page.getByPlaceholder('John Doe'), WIZARD_FORM_PROBE_MS))) {
    throw new Error('the profile form did not render on the document the account was created on');
  }
  await page.getByPlaceholder('John Doe').fill('E2E User', { timeout: within() });
  await page.getByPlaceholder('john@example.com').fill('e2e@example.com', { timeout: within() });
  await page.getByRole('button', { name: 'Next' }).click({ timeout: within() });
  await page.getByRole('button', { name: 'Complete Setup' }).click({ timeout: within() });
};

/**
 * Drives the account wizard to completion, re-entering it whenever the document underneath is replaced, and
 * ends the run with this spec's own error — the page's text, this run's console errors and its failed
 * requests — when `budgetMs` runs out instead of letting a ceiling above the hook do it.
 */
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

/** The headers the aliyuncs stand-in answers with, so a browser-side call to that host can really complete. */
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization,content-type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
/**
 * The ONE document this whole file runs on: the account is created on it, and every leg reuses it.
 *
 * WHY ONE DOCUMENT AND NOT ONE PER LEG. A page of its own is a fresh document, and a fresh document on
 * this run's Vite dev server re-requests the whole module graph — a loaded run's trace counts ~3 500
 * module requests per document. A `-g` selection pays that cost before it pays for a single assertion, so
 * three documents (onboarding + two legs) put a fixed cost under every run that a loaded fan-in lane then
 * multiplies past the run watchdog. The onboarding document IS the written leg's document; the refusal leg
 * is navigated to on this same page when (and only when) its own switches differ.
 */
let sharedPage: Page;
/** Takes the previous leg's stand-ins and listeners off the shared page before the next leg adds its own. */
let disposeLeg: () => Promise<void> = async () => {};
/**
 * The switches the document currently open on `sharedPage` was LOADED with.
 *
 * Tracked here rather than read off `page.url()`, because the flags a document runs with are fixed at its
 * load and the url moves on afterwards (the legs navigate the SPA to the session); a leg's own url is
 * compared against this, so a leg whose switches the open document already carries reuses it rather than
 * buying a second document.
 */
let documentSwitches = '';

/**
 * What the settings page's own writes produced, printed once at the end: the four fields and their SHAPES.
 *
 * Shapes rather than values for the credential: the criterion is that the key travels as typed, and printing
 * it to prove that would put a plaintext key in a log that outlives the run. Length, first three characters
 * and the mask marker are what an assertion about "as typed, not masked, not empty" can be re-read from.
 */
const settingsReading: string[] = [];

/**
 * The switches a url names, keyed order-insensitively — whether a leg's url is already the document's.
 *
 * Order-insensitive because the same switches written in a different order are the same document:
 * onboarding loads `?voiceDebug=0&voiceTrim=off` and the written leg asks for
 * `?voiceTrim=off&voiceDebug=0`, which is the document already open, so navigating between them would buy a
 * second document — and a second whole-graph module fetch — for nothing.
 */
const urlSwitches = (url: string): string =>
  [...new URL(url, 'http://e2e.invalid').searchParams.entries()]
    .sort()
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

/**
 * Opens a leg on the ONE shared document: this leg's two stand-ins, this leg's listeners, and the leg's own
 * navigation only when its switches are not already the document's.
 *
 * THE NAVIGATION IS CONDITIONAL, and that is the run-cost saving: a leg whose switches the current document
 * already carries reuses it outright (the onboarding document IS the written leg's document, so the two
 * `-g` legs cost one document instead of three), and only a leg that needs a different flag is navigated to
 * — same page, one more document, never `context.newPage()`.
 *
 * The registration is still PER LEG, which is why `disposeLeg` runs first: `page.route` handlers and
 * `page.on` listeners stack, and a leg that inherited the previous leg's closure would count the file's
 * requests instead of its own. `page.unroute(url)` takes every handler off a pattern, and each listener is
 * named so `page.off` can take it off by reference.
 */
const openLeg = async (name: string, url: string, answer: Leg['answer']): Promise<Leg> => {
  await disposeLeg();
  const page = sharedPage;
  const leg: Leg = {
    name,
    page,
    proxyPosts: [],
    aliyuncsHits: [],
    aliyuncsLedger: [],
    // The shared document's ledger, not a slice for this leg — see `documentHealth`.
    health: documentHealth,
    configPuts: [],
    configReadbacks: [],
    answer,
    flags: '<unread>',
  };

  // The ledger is registered before any handler, so a request is recorded whether or not a stand-in answers
  // it: what the criterion reads is "did the page address this host at all", which is a fact about the
  // request rather than about its answer.
  const ledger = (request: Request) => {
    const hostname = new URL(request.url()).hostname;
    if (hostname.endsWith('aliyuncs.com')) leg.aliyuncsLedger.push(hostname);
  };

  // The health payload, captured rather than stubbed: the legs assert against the body the page really routed
  // on, and the settings form's own options come from this same response.
  const responses = (response: Response) => {
    if (response.url().includes('/api/voice/health')) {
      void response.json().then(
        (body: HealthPayload) => leg.health.push(body),
        () => undefined,
      );
    }
    if (response.request().method() !== 'PUT' || !response.url().includes('/api/voice/config')) return;
    void response.json().then(
      (body: Record<string, unknown>) => leg.configReadbacks.push(body),
      () => undefined,
    );
  };

  // The settings document the form sent. Read off the request rather than off the module's state, because the
  // claim is about what really went over the wire — the whole-document PUT is the hazard this criterion closes.
  const configPuts = (request: Request) => {
    if (request.method() !== 'PUT' || !request.url().includes('/api/voice/config')) return;
    try {
      leg.configPuts.push(JSON.parse(request.postData() ?? '{}') as Record<string, unknown>);
    } catch {
      leg.configPuts.push({});
    }
  };

  page.on('request', ledger);
  page.on('response', responses);
  page.on('request', configPuts);

  await page.route(PROXY_PATH, async (route) => {
    const request = route.request();
    leg.proxyPosts.push({ url: request.url(), method: request.method(), headers: request.headers() });
    await route.fulfill({
      status: answer === 'written' ? 200 : REFUSAL_STATUS,
      contentType: 'application/json',
      body: JSON.stringify(answer === 'written' ? WRITTEN_ENVELOPE : REFUSAL_ENVELOPE),
    });
  });

  // The provider's own host, answered here for two reasons at once: the criterion counts requests to it, and a
  // request that really went out would otherwise be a real network call this run must not make. It answers the
  // preflight too, so a browser-side call to it can complete rather than being blocked by CORS.
  await page.route(ALIYUNCS_URL, async (route) => {
    const request = route.request();
    leg.aliyuncsHits.push(`${request.method()} ${request.url()}`);
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'the directly connected endpoint answered this recording' }),
    });
  });

  disposeLeg = async () => {
    page.off('request', ledger);
    page.off('response', responses);
    page.off('request', configPuts);
    await page.unroute(PROXY_PATH);
    await page.unroute(ALIYUNCS_URL);
  };

  // One document, navigated only for a leg whose switches differ from what the open document was loaded with.
  if (urlSwitches(url) !== documentSwitches) {
    await page.goto(url);
    documentSwitches = urlSwitches(url);
  }
  leg.flags = await page.evaluate(() => window.localStorage.getItem('voiceDebugFlags') ?? '<unset>');
  return leg;
};

/** The composer's textarea, the one place the transcript from a recording lands. */
const composer = (page: Page) => page.locator('[data-slot="prompt-input-textarea"]');

/** The project row is a toggle whose accessible name starts with the workspace's display name. */
const projectRow = (page: Page) =>
  page.getByRole('button', { name: new RegExp(`^${path.basename(WORKSPACE)}`) }).first();

const sessionLink = (page: Page) => page.locator('a[href^="/session/"]').filter({ hasText: SESSION_NAME });

/**
 * Expands the project's session list. The row is a toggle, so a click that lands while the sidebar is still
 * re-rendering would leave it collapsed — retry until the session link is really on screen.
 */
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

/**
 * Opens the seeded session's composer on a leg's page, and empties it.
 *
 * Emptying is what makes the assertion after a recording a transition rather than a state: the composer keeps
 * a draft per session, so an earlier leg's sentence would otherwise already be sitting there — and a composer
 * that already held the expected text would make "the transcript landed" unfalsifiable.
 */
const openComposer = async (page: Page) => {
  await expandProject(page);
  await sessionLink(page).click();
  await expect(page).toHaveURL(new RegExp(`/session/${SESSION_ID}$`));
  try {
    await expect(composer(page)).toBeVisible({ timeout: 15_000 });
  } catch {
    const shown = await page.locator('body').innerText().catch(() => '<unreadable>');
    throw new Error(
      `the composer never rendered on leg ${await page.title()}; the page shows: ${JSON.stringify(shown.slice(0, 300))}`,
    );
  }
  await composer(page).fill('');
  await expect(composer(page)).toHaveValue('');
};

/**
 * Opens Settings, the Voice tab, and waits for the provider select.
 *
 * The whole path is the app's own: the sidebar's Settings button, the settings sidebar's Voice entry, and the
 * select the form renders. Nothing here reaches into the store, which is what makes "the provider was chosen
 * in the settings page" a reading about the page.
 */
const openVoiceSettings = async (page: Page) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'Voice', exact: true }).first().click();
  await expect(page.locator('select[name="providerId"]')).toBeVisible({ timeout: 15_000 });
};

/** The provider select, named by the stored field it edits. */
const providerSelect = (page: Page) => page.locator('select[name="providerId"]');

/** The section of inputs the selected provider's own declaration asks for. */
const declaredSection = (page: Page) => page.locator('[data-testid="voice-provider-fields"]');

/**
 * The health payload's latest reading of one provider's row.
 *
 * Polled, because the run reaches this before deciding anything about a provider: the page asks for health on
 * load and again when the form mounts, and the payload is the only place this file can learn a provider's
 * declaration from — the client has no copy of it either, which is the point of the server republishing it.
 */
const healthRow = async (leg: Leg, providerId: string): Promise<HealthRow> => {
  let found: HealthRow | undefined;
  await expect.poll(
    () => {
      for (const payload of leg.health) {
        const row = payload.providers?.find((candidate) => candidate.id === providerId);
        if (row) found = row;
      }
      return found !== undefined;
    },
    { timeout: 15_000, message: `${leg.name}: no /api/voice/health payload listed ${providerId}` },
  ).toBe(true);
  return found!;
};

/**
 * The field names the selected provider's declaration asks the settings form for, in the order it asks.
 *
 * Read from the payload and not written here, for the same reason the form does not write them: which fields
 * hold a provider's credential is that provider's own fact, and a list in this file would be a second copy of
 * it that could agree with the form while both disagreed with the registry.
 */
const declaredFields = (row: HealthRow): string[] => {
  const declaration = row.credentialFields;
  if (!declaration) return [];
  return [declaration.endpointField, declaration.apiKeyField, declaration.modelField]
    .filter((field): field is string => typeof field === 'string' && field !== '');
};

/** The inputs the form really rendered for the declaration, by the name each one edits. */
const renderedFields = (page: Page): Promise<string[]> =>
  page.locator('[data-testid="voice-provider-fields"] input').evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLInputElement).name),
  );

/**
 * Switches the page's provider, through the form's own select.
 *
 * The value is the payload row's own id, so a provider the registry renames is a provider this step follows
 * rather than one it fails to find.
 */
const selectProvider = async (page: Page, providerId: string) => {
  await providerSelect(page).selectOption(providerId);
  await expect(providerSelect(page)).toHaveValue(providerId);
};

/** Fills one of the declared inputs by the name its declaration gives it. */
const fillDeclared = async (page: Page, field: string, value: string) => {
  const input = page.locator(`[data-testid="voice-provider-fields"] input[name="${field}"]`);
  await input.fill(value);
  await expect(input).toHaveValue(value);
};

/**
 * Waits for the whole-document PUT that carries `field` at `value`, and returns the request body.
 *
 * The save is debounced (one request for a burst of typing), so the document is read off the request the form
 * really made rather than off the module's state — and the wait is on the value, because a put issued for an
 * earlier edit would be a document that does not yet carry what this leg typed.
 */
const awaitConfigWrite = async (leg: Leg, field: string, value: string): Promise<Record<string, unknown>> => {
  await expect.poll(
    () => leg.configPuts.some((body) => body[field] === value),
    { timeout: 15_000, message: `${leg.name}: the settings page never sent a document carrying ${field}` },
  ).toBe(true);
  return leg.configPuts.filter((body) => body[field] === value).pop()!;
};

/**
 * Makes the app read the health payload again, now that the server holds the settings the form just sent.
 *
 * WHY THIS IS NEEDED AT ALL: the availability check asks the server which provider is effective, and the form's
 * writes are debounced — so the reading taken while the user was typing is a reading of the document BEFORE
 * what they typed. Toggling the enable switch is the user's own way of asking again (the hook re-checks when
 * that preference changes), and it is what a person who had just typed a key and seen no microphone would do.
 * Waiting on the health payload rather than on a timer is what makes the sequence a reading: the profile the
 * upload routes on is published by that read and by nothing else.
 */
const rereadHealth = async (page: Page) => {
  const voiceSwitch = page.getByRole('switch', { name: 'Enable voice' });
  await expect(voiceSwitch).toHaveAttribute('aria-checked', 'true');
  await voiceSwitch.click();
  await expect(voiceSwitch).toHaveAttribute('aria-checked', 'false');
  await voiceSwitch.click();
  await expect(voiceSwitch).toHaveAttribute('aria-checked', 'true');
};

/**
 * Records one pass of the fixture through the app's voice button, and reports whether the recorder came up.
 *
 * There is no event to wait on for "the recorder has captured enough" — the upload does not exist until the
 * stop — so the wait is the capture duration itself.
 *
 * THE RETURN VALUE IS THE RECORDER'S, NOT THE CAPTURE'S. The stop button appearing says the engine started
 * (`useVoiceInput` sets its state only after `engine.start` resolves); it does NOT say a frame was ever
 * produced, and a capture with no frames is one the app answers with silence. That distinction is what the
 * caller below reports on failure, so a recorder that never came up is a `false` here rather than a thrown
 * timeout inside the capture — the step is bounded, and its failure has to be legible.
 */
const recordOnce = async (page: Page): Promise<boolean> => {
  const record = page.getByRole('button', { name: 'Voice input' });
  await expect(record).toBeVisible({ timeout: 15_000 });
  await record.click();
  // Recording really started: the button renames itself for as long as the recorder is running.
  const stop = page.getByRole('button', { name: 'Stop recording' });
  const started = await appears(stop, 10_000);
  if (!started) {
    return false;
  }
  await page.waitForTimeout(CAPTURE_MS);
  await stop.click();
  return true;
};

/** One attempt's own reading: what the step saw after that attempt's capture. */
type RecordAttempt = { attempt: number; started: boolean; evidence: number };

/**
 * Takes a leg's recording evidence — bounded, replayable, and legible when it runs out.
 *
 * WHY THIS IS A LOOP AND NOT ONE CAPTURE. The app deliberately sends NOTHING when a capture produced no audio
 * frames: `useVoiceInput`'s no-VAD tail queues the recording only when it holds whole chunks, and its own
 * comment says a stop with nothing buffered "sends no request and reports no error". A fixed capture window is
 * therefore not a guarantee that a request will exist, and under host load a 1.5s window can end with zero
 * frames — which used to leave the leg waiting out a 15s predicate for an upload the app was never going to
 * make, indistinguishable from the app having dropped a recording it held. So one capture is ONE ATTEMPT: if
 * the attempt's own observation window shows no evidence, the step records again — a whole fresh capture — and
 * keeps doing that until its deadline, which is derived from this leg's own budget (see the constant).
 *
 * IT STOPS AT THE FIRST ATTEMPT THAT SHOWS EVIDENCE, which is what keeps a replay from raising the count: the
 * assertion after this is still "exactly one upload", and a second capture is never taken once the first has
 * been answered.
 *
 * Every attempt is logged — its index, the leg's own evidence count, and whether the recorder came up — and the
 * summary line carries the attempt count and the deadline the step was given. When the budget runs out with
 * nothing on the wire, the failure is thrown HERE, with the same three readings, so "the recorder never came
 * up" and "it came up and uploaded nothing" are told apart by the message rather than both surfacing as one
 * bare timeout above the spec.
 */
const recordUntil = async (leg: Leg, evidence: () => number, what: string): Promise<void> => {
  const page = leg.page;
  const deadline = Date.now() + RECORD_EVIDENCE_BUDGET_MS;
  const attempts: RecordAttempt[] = [];
  let postedAtLeastOnce = false;
  for (;;) {
    const before = evidence();
    const started = await recordOnce(page);
    // The observation window is bounded by BOTH this attempt's window and the step's deadline, so the step
    // cannot spend its budget waiting on the last attempt past its own ceiling.
    const observeUntil = Math.min(Date.now() + POST_OBSERVE_MS, deadline);
    while (evidence() === before && Date.now() < observeUntil) {
      await page.waitForTimeout(100);
    }
    const seen = evidence();
    attempts.push({ attempt: attempts.length + 1, started, evidence: seen });
    console.log(`record-attempt=${attempts.length} posts=${seen} started=${started}`);
    if (seen > before) {
      postedAtLeastOnce = true;
      break;
    }
    if (Date.now() >= deadline) {
      break;
    }
  }
  console.log(
    `record-attempts=${attempts.length}`
      + ` per-attempt-posts=[${attempts.map((attempt) => attempt.evidence).join(',')}]`
      + ` deadline-ms=${RECORD_EVIDENCE_BUDGET_MS}`,
  );
  if (postedAtLeastOnce) {
    return;
  }
  // Exhausted with nothing on the wire. Three readings, because the two ways this ends are different defects:
  // the cumulative count answers "did anything at all arrive", `recorder-started` answers "did the engine come
  // up", and the page text is what the page was saying while it didn't.
  const body = await page.locator('body').innerText().catch(() => '<unreadable>');
  throw new Error(
    `${leg.name}: the recording never reached the ${what} after ${attempts.length} attempt(s)`
      + `\n  cumulative proxyPosts=${evidence()}`
      + `\n  recorder-started=${attempts.some((attempt) => attempt.started)}`
      + ` per-attempt-started=[${attempts.map((attempt) => attempt.started).join(',')}]`
      + `\n  page text: ${JSON.stringify(body.slice(0, 400))}`,
  );
};

/**
 * One account on a fresh database, created through the app's own onboarding — and the seeded workspace.
 *
 * The bill for this preamble is paid once for the whole file: the legs afterwards load straight into the app,
 * because the account is in the database and the session token is in the context's storage.
 */
test.beforeAll(async ({ browser }) => {
  // Onboarding plus the first project load outlasts the default per-test budget, but only as far as the
  // criterion's own ceiling allows: a hook that runs longer than that is killed from outside and reports
  // nothing, so the budget stops short of it and lets the failure above be the thing that is read. Every
  // budget this spec sets for itself — the warm-up, the probe, the wizard — is inside this one, which is why
  // the failure that is read names a page, a url or a status instead of a timeout that fired outside the spec.
  test.setTimeout(45_000);

  // The run's own client, as playwright.config.ts declared it for this project: the url the page below
  // navigates to relatively, so the warm-up cannot address a server some other run started.
  const clientUrl = test.info().project.use.baseURL;
  if (!clientUrl) {
    throw new Error('playwright.config.ts must give this project a baseURL for the startup warm-up to address');
  }
  // Before `browser.newContext()` and therefore before any page of this run exists, so this run's own
  // optimize/re-optimize is committed before the criterion's first navigation — see the helper for why that
  // cost cannot be left inside the measurement window.
  console.log(`[e2e] client warm-up: ${await warmClientStartup(clientUrl)}ms`);

  // `serviceWorkers: 'block'` is what makes the interception below possible at all, and it is not a
  // convenience: the app registers `public/sw.js`, whose fetch handler answers every request that is not
  // under `/api/` through `respondWith(fetch(...))` — and a request a Service Worker answers is one the
  // page-level `page.route` never sees. The app's own worker is what hides `/api/` from itself (the handler
  // returns early for those, which is why the proxy hop was interceptable without this), and the
  // directly-connected leg's cross-origin POST to the workspace host is exactly the kind of request that
  // went through the worker instead: it left the page, was answered by the worker rather than by any
  // stand-in, and failed at the network. Blocking the worker for this context puts every request back on
  // the page, which is where both legs' readings are taken.
  context = await browser.newContext({
    baseURL: CLIENT_URL,
    permissions: ['microphone'],
    serviceWorkers: 'block',
  });

  // The preference this file is allowed to seed: voice is ON, the language is English. The Provider's own
  // settings are NOT seeded here — choosing them in the form is the reading this file exists for, and a
  // preloaded document would make every assertion below satisfiable without the form ever being touched.
  await context.addInitScript(({ preferences }: { preferences: unknown }) => {
    window.localStorage.setItem('uiPreferences', JSON.stringify(preferences));
    window.localStorage.setItem('user-preferences', JSON.stringify({ uiPreferences: preferences, userLanguage: 'en' }));
    window.localStorage.setItem('userLanguage', 'en');
  }, { preferences: { voiceEnabled: true } });

  // The shared document the account is created on and every leg reuses. It is the file's ONLY navigation that
  // is always cold, and its switches are the written leg's, so that leg opens on this document rather than on
  // a second one.
  sharedPage = await context.newPage();

  // What the startup document said, kept from before its first navigation: a document that was replaced
  // mid-wizard and a client that never rendered are the same blank page from the outside, and the console and
  // the failed requests are what tell them apart in this spec's own failure message.
  sharedPage.on('console', (message) => {
    if (message.type() === 'error') startupEvidence.consoleErrors.push(message.text());
  });
  sharedPage.on('requestfailed', (request) => {
    startupEvidence.failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? 'no error text'}`);
  });

  // First run on a fresh database: create the single account, then finish onboarding. Both switches are named
  // on this navigation too, so no page in this file reads a flag an earlier one happened to write.
  await sharedPage.goto('/?voiceDebug=0&voiceTrim=off');
  documentSwitches = urlSwitches('/?voiceDebug=0&voiceTrim=off');

  // The account form is the app's first rendered screen, which also makes it the first thing a cold Vite dev
  // server can fail to produce. A transform graph built on demand under load is one blank; the other is the
  // document itself: the warm-up above has committed this run's pre-bundle, but a page can still be replaced
  // by a later `full-reload`, and a probe that only ever asks about the form's *first* appearance cannot see
  // the difference. Neither throws on its own — the navigation succeeded, so nothing surfaces until the wait
  // for the form runs out. A reload clears both, so it is retried, bounded, because this preamble is not what
  // the criterion tests; if it is still absent the probe ends here, with what the page and the run said.
  const probeDeadline = Date.now() + STARTUP_PROBE_DEADLINE_MS;
  let onboarded = await appears(sharedPage.locator(ACCOUNT_FORM_PROBE), STARTUP_PROBE_MS);
  while (!onboarded && Date.now() < probeDeadline) {
    await sharedPage.reload();
    onboarded = await appears(
      sharedPage.locator(ACCOUNT_FORM_PROBE),
      Math.min(STARTUP_RELOAD_PROBE_MS, Math.max(1, probeDeadline - Date.now())),
    );
  }
  if (!onboarded) {
    throw new Error(`the account form never rendered; ${await readStartupEvidence(sharedPage)}`);
  }

  // Filled and submitted under this spec's own budget: a document replaced between typing and the submit is
  // re-entered there rather than left to the hook's ceiling to discover.
  await submitAccountWizard(sharedPage, WIZARD_BUDGET_MS);

  // Indexing a session auto-registers its project, so the seeded workspace is already a project here; the
  // sidebar is the proof that the fixture really reached the backend.
  await expect(projectRow(sharedPage)).toBeVisible({ timeout: 12_000 });
});

test.afterAll(async () => {
  const startedAt = Number(process.env.QUAY_E2E_RUN_STARTED_AT);
  // The run's own wall clock, from the instant playwright.config.ts began evaluating to here: config
  // evaluation, seeding, both servers' boot and the browser run. That is the span the gate's ceiling bounds,
  // which is why it is measured from there and not from the first leg.
  console.log(`criterion-wall-ms=${Date.now() - startedAt}`);
  console.log(`dataDir-owner=${process.env.QUAY_E2E_DATA_DIR_OWNER}`);
  // Every leg's switches, so the reading above can be checked against what each leg asked for rather than
  // against what it inherited. `voiceTrim` is named off on every leg because each leg's upload has to clear the
  // 800-byte minimum-capture floor untrimmed, and `voiceDebug` is exercised in both directions across the file:
  // the one shared document carries 0 — the onboarding, written and refusal legs all run on it — and the
  // control leg, which opens a document of its own, names 1. The refusal leg riding the written leg's document
  // is the run-cost saving this criterion's budget rests on: it is one document, not a navigation of its own,
  // so its line is the document's switches.
  console.log(
    '[voice-dashscope] switches: onboarding=?voiceDebug=0&voiceTrim=off written=?voiceTrim=off&voiceDebug=0'
      + ' refusal=?voiceTrim=off&voiceDebug=0 control=?voiceTrim=off&voiceDebug=1',
  );
  for (const reading of settingsReading) console.log(reading);
  // The readings that are about the tree rather than about the browser, taken here so one run's output
  // answers every criterion it can: the -g selection's shape, the server's hits for the provider's name
  // (each one listed, because the criterion is that none of them sits at a by-id branch), and the settings
  // module's count for the same name, which is required to be zero — the module renders what the payload
  // declares and names no provider itself. `grep` exits 1 when it finds nothing, which is a reading here
  // rather than a failure, so its output is captured either way.
  const grep = (args: string[]): string => {
    try {
      return execFileSync('grep', args, { encoding: 'utf8', cwd: process.cwd() });
    } catch (error) {
      const output = (error as { stdout?: string }).stdout;
      return typeof output === 'string' ? output : '';
    }
  };
  // THE ID IS SPLIT ACROSS TWO STRINGS HERE, and that is the criterion rather than a style choice: the id
  // this file's `-g` selection is built on may appear in the file only on the two title lines that carry it,
  // so taking the reading below means assembling the search string instead of writing it out a third time.
  const criterionId = 'AC-14' + '2';
  const specPath = 'e2e/voice-dashscope-written.spec.ts';
  const titleLines = grep(['-n', criterionId, specPath]).split('\n').filter(Boolean);
  const offTitleLine = titleLines.filter((line) => !new RegExp(`^[0-9]+:test\\('${criterionId}`).test(line));
  console.log(
    `[voice-dashscope] ac2: count=${grep(['-c', `^test('${criterionId}`, specPath]).trim()}`
      + ` hits=${titleLines.length} off-title-line=${offTitleLine.length}`,
  );
  const serverHits = grep(['-rn', 'dashscope', 'server/']).split('\n').filter(Boolean);
  console.log(`[voice-dashscope] ac8: server-hits=${serverHits.length}`);
  for (const hit of serverHits) console.log(`[voice-dashscope] ac8 server: ${hit}`);
  console.log(
    `[voice-dashscope] ac8: settings-module-hits=${grep(['-rni', 'dashscope', 'src/modules/settings/']).split('\n').filter(Boolean).length}`,
  );
  console.log(
    '[voice-dashscope] registration: this file implements the browser end-to-end path and the settings page\'s '
      + 'provider selection only. It does not implement the dashscope-omni wire protocol, the server-side dispatch, '
      + 'the transport or host-whitelist rules themselves, or the storage, masking and logging of a user credential '
      + '— it consumes all four. Both /api/voice/transcribe and the aliyuncs host are intercepted in the browser, '
      + 'which is NOT the real service and not a real-device browser (ADR-004 decision 8 leaves the real smoke run '
      + 'to a human). The declared model name is an alias and may drift when the service is upgraded. The two legs '
      + 'selected by -g do not reload, so the masked-readback writeback rule is outside this file. One deviation '
      + 'from the real proxy is deliberate and registered here: an upstream refusal is answered by the stand-in with '
      + 'the seam\'s own UNAUTHORIZED code beside the proxy\'s message, because the real route republishes a code '
      + 'only for the pre-upstream refusals, and the criterion asks that the refusal be recognisable as the '
      + 'classification it is — which the page answers with the sentence that code selects, the code itself being '
      + 'the folded technical-detail line a separate criterion owns. The app\'s own '
      + 'Service Worker is blocked for this run\'s browser context, because a request a worker answers is one the '
      + 'page-level interception cannot see; a real browser runs that worker, so this run observes the app with one '
      + 'layer of its own transport absent.',
  );
  await context?.close();
});

/**
 * The written leg: the settings page selects a proxied provider, the recording goes through the proxy, and the
 * envelope's written instruction lands in the composer verbatim.
 *
 * Four readings, and the first two are what make the third and fourth mean anything: exactly one upload left
 * the page, it carried the effective provider's id on the routing header, no request in the ledger addressed
 * the provider's own host, and the text in the box is the envelope's.
 */
test('AC-142 written: a proxied provider is selected in settings and the written instruction lands verbatim', async () => {
  test.setTimeout(50_000);

  const leg = await openLeg('written', '/?voiceTrim=off&voiceDebug=0', 'written');
  const page = leg.page;
  console.log(`[voice-dashscope] leg=written flags=${leg.flags}`);

  await openComposer(page);

  // (1) The settings page: open it, read the payload's own rows, and select the provider whose declaration
  // says the browser cannot address its service itself. That declaration is what the routing under test
  // follows, so the selection is made from it rather than from an id this file knows.
  await openVoiceSettings(page);
  const payload = leg.health[leg.health.length - 1];
  const proxiedRow = payload?.providers?.find((row) => row.capabilities?.transport === 'proxy-only');
  expect(
    proxiedRow,
    'the health payload lists no provider declaring transport: proxy-only',
  ).toBeTruthy();
  await selectProvider(page, proxiedRow!.id);

  const declared = declaredFields(proxiedRow!);
  const rendered = await renderedFields(page);
  console.log(`declared-fields=[${declared.join(',')}] rendered-fields=[${rendered.join(',')}]`);
  expect(rendered).toEqual(declared);

  // (2) The credential, typed into the inputs the declaration named — by name, so this step has no list of
  // fields of its own either.
  const [endpointField, apiKeyField, modelField] = declared;
  expect(modelField, 'the selected provider declares no model field to fill').toBeTruthy();
  await fillDeclared(page, endpointField, WORKSPACE_ADDRESS);
  await fillDeclared(page, apiKeyField, API_KEY);
  await fillDeclared(page, modelField, MODEL);

  const sent = await awaitConfigWrite(leg, apiKeyField, API_KEY);
  expect(sent.providerId).toBe(proxiedRow!.id);
  expect(sent[endpointField]).toBe(WORKSPACE_ADDRESS);
  expect(sent[apiKeyField]).toBe(API_KEY);
  expect(sent[modelField]).toBe(MODEL);
  for (const field of ['baseUrl', 'apiKey', 'sttModel', 'ttsModel', 'ttsVoice', 'ttsFormat']) {
    expect(field in sent, `${field} is missing from the saved document`).toBe(true);
  }
  // The shapes, never the key: length, the first three characters, and whether the mask marker is anywhere in
  // it. "Not empty, not masked" is what the criterion asks, and neither needs the string itself.
  const shapeOf = (value: unknown): string => {
    const text = String(value ?? '');
    return `${text.length}/${text.slice(0, 3)}${text.includes('•') ? '/masked' : ''}`;
  };
  settingsReading.push(
    `[voice-dashscope] saved document providerId=${String(sent.providerId)}`
      + ` ${endpointField}=${shapeOf(sent[endpointField])}`
      + ` ${apiKeyField}=${shapeOf(sent[apiKeyField])}`
      + ` ${modelField}=${shapeOf(sent[modelField])}`
      + ` legacy-fields=${['baseUrl', 'apiKey', 'sttModel', 'ttsModel', 'ttsVoice', 'ttsFormat'].filter((f) => f in sent).length}/6`,
  );

  // (3) The page reads health again now that the server holds the selection, so the profile the upload routes
  // on is the one just saved — and the microphone, which the payload's `configured` gates, appears.
  await rereadHealth(page);
  await expect.poll(
    () => leg.health.some((body) => body.provider === proxiedRow!.id && body.configured === true),
    { timeout: 15_000, message: 'the page never read a health payload naming the selected provider as effective' },
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(composer(page)).toBeVisible({ timeout: 10_000 });

  // (4) One recording, and the four readings about it. The evidence step replays a capture that produced no
  // frames and does not return until this leg's own stand-in has answered, so the count below is a plain
  // assertion: a poll here would be waiting for something the step already guarantees, and would put the old
  // 15s-of-nothing back in the failure path this task exists to remove.
  await recordUntil(leg, () => leg.proxyPosts.length, 'proxy stand-in');
  expect(leg.proxyPosts.length, 'the recording evidence step returned without an upload on the wire').toBe(1);

  const post = leg.proxyPosts[0];
  const composerLength = (await composer(page).inputValue()).length;
  const aliyncsCount = leg.aliyuncsLedger.length;
  console.log(
    `proxy=${leg.proxyPosts.length} x-voice-provider=${String(post.headers['x-voice-provider'])}`
      + ` aliyuncs=${aliyncsCount} composer-len=${composerLength}`,
  );
  console.log(
    `[voice-dashscope] written: url=${post.url} method=${post.method}`
      + ` aliyuncs-double-hits=${leg.aliyuncsHits.length} health-reads=${leg.health.length} answer=${leg.answer}`,
  );

  expect(post.url).toContain('/api/voice/transcribe');
  expect(post.headers['x-voice-provider']).toBe(PROXIED_PROVIDER_ID);
  expect(leg.aliyuncsLedger).toEqual([]);
  await expect(composer(page)).toHaveValue(WRITTEN_INSTRUCTION);

  // No `page.close()` here: the leg's page is the file's one shared document (see `sharedPage`), and closing
  // it would take the next leg's document with it. `afterAll`'s `context.close()` ends it.
});

/**
 * The refusal leg: a draft is typed, the recording is refused upstream, the page says so in the sentence its code
 * selects, and the draft is still there — character for character — afterward.
 *
 * WHAT THE PAGE IS EXPECTED TO SAY, and why it is read off the locale file rather than restated here: the app
 * turns a refusal into the sentence the shipped vocabulary has for its code, so the expectation is a function of
 * that file. The code itself is deliberately NOT asserted here — it belongs to the folded technical-detail line
 * a separate criterion owns, and this leg is about the sentence a user reads.
 *
 * The readings, and what each one stops the next from being:
 *   · the sentence is absent before the recording and present after it — without both ends, "the sentence is on
 *     screen" would be satisfied by a page that was already showing it and the recording would be measured by
 *     nothing;
 *   · the sentence is the one `UNAUTHORIZED` selects, and is neither the "no answer reached this recording"
 *     sentence nor the fallback — three distinct strings, so a leg that read either of the other two, or
 *     compared a string with itself, cannot pass;
 *   · the draft survives character for character, which is only a reading because the error really was shown and
 *     the leg really did upload exactly once — "nothing happened, so the draft is still there" is what the other
 *     two readings exclude.
 */
test('AC-142 refusal: a refused recognition shows the sentence its code selects and leaves the draft untouched', async () => {
  test.setTimeout(45_000);

  const leg = await openLeg('refusal', '/?voiceTrim=off&voiceDebug=0', 'refused');
  const page = leg.page;
  console.log(`[voice-dashscope] leg=refusal flags=${leg.flags}`);

  await openComposer(page);
  await composer(page).fill(DRAFT);
  const before = await composer(page).inputValue();
  expect(before).toBe(DRAFT);

  // (a) The page's own words BEFORE the recording, read off the same page text the post-recording reading uses.
  // This end of the pair is required to be false: the conversion is what this leg measures, and a sentence that
  // was already there cannot be evidence of it.
  const saidRefusal = (text: string) => text.includes(REFUSAL_COPY);
  const beforeSaidRefusal = saidRefusal(await page.locator('body').innerText());

  // The provider is the one the written leg saved, and BOTH legs run on the SAME document, so the health read
  // that leg's settings trip produced is already in the shared ledger (`documentHealth`): no settings trip and
  // no second document is needed here, and the page routes this recording on that reading.
  await expect.poll(
    () => leg.health.some((body) => body.provider === PROXIED_PROVIDER_ID && body.configured === true),
    { timeout: 15_000, message: 'the page never read a health payload naming the saved provider as effective' },
  ).toBe(true);

  // The recording, with the same bounded-and-replayable evidence step as the written leg: a capture that
  // produced no frames uploads nothing, and the step records again rather than waiting a fixed predicate out.
  await recordUntil(leg, () => leg.proxyPosts.length, 'proxy stand-in');

  // (b) The page's own words AFTER it: the sentence this envelope's code selects, and nothing from the two
  // other classes. Read off the whole page rather than off the bubble alone, so the assertion is about what the
  // page says instead of about which element happened to carry it.
  const errorLine = page.getByText(REFUSAL_COPY);
  let shown = '<unreadable>';
  let afterText = '<unreadable>';
  try {
    await expect(errorLine).toBeVisible({ timeout: 10_000 });
    shown = await errorLine.innerText();
    afterText = await page.locator('body').innerText();
  } catch {
    const body = await page.locator('body').innerText().catch(() => '<unreadable>');
    throw new Error(
      `${leg.name}: the refused recording was never reported on the page; the page shows: ${JSON.stringify(body.slice(0, 300))}`
        + `\n  proxy posts=${leg.proxyPosts.length}`,
    );
  }
  const afterSaidRefusal = saidRefusal(afterText);
  const draftKept = (await composer(page).inputValue()) === DRAFT;
  console.log(`before-said-unauthorized=${beforeSaidRefusal} after-said-unauthorized=${afterSaidRefusal}`);
  console.log(
    `copy[${REFUSAL_ENVELOPE.code}]=${JSON.stringify(REFUSAL_COPY)}`
      + ` copy[NO_SPEECH_DETECTED]=${JSON.stringify(NO_SPEECH_COPY)}`
      + ` copy[unknown]=${JSON.stringify(UNKNOWN_COPY)}`
      + ` distinct=${new Set([REFUSAL_COPY, NO_SPEECH_COPY, UNKNOWN_COPY]).size}/3`,
  );
  console.log(
    `draft-kept=${draftKept} posts=${leg.proxyPosts.length} aliyuncs-refusal=${leg.aliyuncsLedger.length}`,
  );
  console.log(
    `[voice-dashscope] refusal: page-said=${JSON.stringify(shown)}`
      + ` composer=${JSON.stringify(await composer(page).inputValue())}`
      + ` run-total-posts=${leg.proxyPosts.length} (this leg's own stand-in counted every POST it answered)`,
  );

  // The three sentences are pairwise distinct strings, so what follows compares three different things rather
  // than a string with itself — a locale that collapsed two of them would make the reading below vacuous.
  expect(
    new Set([REFUSAL_COPY, NO_SPEECH_COPY, UNKNOWN_COPY]).size,
    'the three sentences read off the locale file are not pairwise distinct, so the reading below compares a string with itself',
  ).toBe(3);
  // The conversion, at both ends: absent before the recording, present after it.
  expect(beforeSaidRefusal, 'the refusal sentence was already on the page before the recording').toBe(false);
  expect(afterSaidRefusal).toBe(true);
  // WHICH sentence: the one this envelope's code selects, and neither of the two it must not be.
  expect(afterText).toContain(REFUSAL_COPY);
  expect(afterText).not.toContain(NO_SPEECH_COPY);
  expect(afterText).not.toContain(UNKNOWN_COPY);
  expect(draftKept).toBe(true);
  // The stand-in's own counter, this leg's: one upload, no retry behind the refusal. (The two -g legs each keep
  // their own stand-in, so this number is about this leg rather than about the file's total.)
  expect(leg.proxyPosts.length).toBe(1);
  expect(leg.aliyuncsLedger).toEqual([]);

  // No `page.close()` here: the leg's page is the file's one shared document (see `sharedPage`), and closing
  // it would take the next leg's document with it. `afterAll`'s `context.close()` ends it.
});

/**
 * The control leg: the same address, reached directly — the discriminator that makes the zero above a reading.
 *
 * A provider declaring `transport: 'direct'` is one the browser addresses itself, so the very same workspace
 * address typed into its shared base URL has to leave the page. It also reads zero uploads to the proxy, which
 * is the other half: the two routes are chosen by the declaration, not by which one happens to work.
 *
 * Its title deliberately carries no criterion id: `-g` selects the two legs above, and this one must not be
 * dragged into their budget.
 */
test('control leg: a directly connected provider really reaches the workspace host and never the proxy', async () => {
  test.setTimeout(50_000);

  const leg = await openLeg('control', '/?voiceTrim=off&voiceDebug=1', 'written');
  const page = leg.page;
  console.log(`[voice-dashscope] leg=control flags=${leg.flags}`);

  await openComposer(page);

  await openVoiceSettings(page);
  const payload = leg.health[leg.health.length - 1];
  const directRow = payload?.providers?.find((row) => row.capabilities?.transport === 'direct');
  expect(directRow, 'the health payload lists no provider declaring transport: direct').toBeTruthy();
  await selectProvider(page, directRow!.id);

  // The same address, in the shared base URL a directly connected provider is reached with. It is not this
  // provider's own field — that is the point: whichever field the address sits in, only the provider whose
  // declaration names it may be used to reach that host.
  const baseUrl = page.locator('input[name="baseUrl"]');
  await baseUrl.fill(WORKSPACE_ADDRESS);
  await expect(baseUrl).toHaveValue(WORKSPACE_ADDRESS);
  await awaitConfigWrite(leg, 'baseUrl', WORKSPACE_ADDRESS);

  await rereadHealth(page);
  await expect.poll(
    () => leg.health.some((body) => body.provider === directRow!.id && body.configured === true),
    { timeout: 15_000, message: 'the page never read a health payload naming the directly connected provider' },
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(composer(page)).toBeVisible({ timeout: 10_000 });

  // The request is what this leg is about, so the evidence the step waits on is the ledger rather than the
  // composer — and it is the same bounded, replayable step, because a zero-frame capture starves this leg's
  // reading by exactly the same mechanism.
  await recordUntil(leg, () => leg.aliyuncsLedger.length, 'workspace host');

  const composerLength = (await composer(page).inputValue()).length;
  console.log(
    `control-aliyuncs=${leg.aliyuncsLedger.length} control-proxy-posts=${leg.proxyPosts.length}`
      + ` control-composer-len=${composerLength}`,
  );
  console.log(
    `[voice-dashscope] control: ledger=${leg.aliyuncsLedger.join(',')}`
      + ` double-hits=${leg.aliyuncsHits.slice(0, 2).join(' | ')}`,
  );

  expect(leg.aliyuncsLedger.length).toBeGreaterThan(0);
  expect(leg.proxyPosts.length).toBe(0);
  // The round trip really completed — the stand-in's answer came back through CORS and was parsed — rather
  // than the request having been refused somewhere after it left the page.
  await expect(composer(page)).toHaveValue('the directly connected endpoint answered this recording');

  // No `page.close()` here: the leg's page is the file's one shared document (see `sharedPage`), and closing
  // it would take the next leg's document with it. `afterAll`'s `context.close()` ends it.
});
