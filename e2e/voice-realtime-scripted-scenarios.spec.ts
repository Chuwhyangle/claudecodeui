/**
 * gap-live-voice-e2e-scripted-upstream — the Live Voice browser criteria on ONE shared, REAL-socket
 * scripted upstream that speaks the SAME event vocabulary the server-side criteria use.
 *
 * WHAT THIS FILE IS FOR. Four real-browser Live Voice specs each hand-roll their own `ws` stand-in
 * and each speaks only the handful of frames its own case needs (`voice-realtime-live-session-send`,
 * `voice-realtime-upload-fixture`, `voice-realtime-composer-embedded`, `voice-realtime-turn-unanswered`).
 * The vocabulary was closed on the server side (`voice-realtime-scripted-upstream.ts`) for the
 * in-process criteria; this file closes it for the BROWSER: one helper (`voiceRealtimeScriptedUpstream.ts`)
 * binds a real `WebSocketServer` on the port `playwright.config.ts` points the app at, and every frame
 * it says comes from the server module's own builders.
 *
 * WHAT IS REAL AND WHAT IS NOT. Real: the browser, the app server, the `/voice-realtime` proxy, the
 * bridge, the executor, the real `session_send`/`session_interrupt` and the transcript write. Not
 * real: the microphone (no CI machine has one — an init script installs an inert Web Audio graph this
 * file never pushes into) and the DashScope endpoint itself (the app dials the port below).
 *
 * CLOUD API IS FORBIDDEN BY CONSTRUCTION (AC1/AC2). `playwright.config.ts` sets `DASHSCOPE_API_KEY`
 * to the EMPTY STRING on this selection's server, overriding whatever ambient value the run inherited.
 * The transport's guard dials with no credential when the key is empty and a socket factory is
 * injected, so the handshake this file reads carries no `Authorization` header — the runtime proof
 * that "point it at the wrong place" can only ever reach an unauthenticated session, never DashScope.
 * Withhold the endpoint (AC1's false form) and the guard has no factory at all: it refuses with
 * `MISSING_API_KEY`, no dial is made and this file's first case reds.
 *
 * ⛔ fan-in's suite (`scripts/test.sh`) does not run Playwright: every criterion here is self-certified,
 * and the Evidence in the task body carries the readings.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, request, test, type APIRequestContext, type ConsoleMessage, type Page } from '@playwright/test';

import {
  captionCompleted,
  captionDelta,
  functionCall,
  startScriptedUpstream,
  type ScriptedUpstreamServer,
} from './voiceRealtimeScriptedUpstream';

const PANE = '.chat-messages-pane';
const USER_ROW = '[data-message-style="user"]';
/**
 * The user row's bubble prose. A row's `textContent` also carries the timestamp and the heard/undelivered
 * pill, so the transcript is read off the `dir="auto"` node the authored text lives in — the node a
 * person reads as "what was said".
 */
const USER_ROW_PROSE = `${USER_ROW} div[dir="auto"]`;
/** The composer's textarea testid — present exactly while `ChatComposer` is mounted. */
const COMPOSER_TEXTAREA = '[data-slot="prompt-input-textarea"]';
const BAR = '[data-testid="voice-realtime-bar"]';
/**
 * The seam the bar used to draw to say a turn had stopped — removed by the strip
 * (`gap-voice-ui-strip-to-caption-and-connection-state`, 2026-10-14). Read here as an ABSENCE, and by
 * testid PREFIX, so a notice coming back under a different name fails this reading too.
 */
const STOP_NOTICE_PREFIX = '[data-testid^="voice-realtime-stop"]';

const USERNAME = 'voice-realtime-e2e';
const PASSWORD = 'voice-realtime-e2e-pass';
const TITLE = 'Voice scripted-upstream arm';
const SEED_USER_TEXT = 'seeded user turn for the scripted upstream criterion';

/** The one utterance AC5 folds: two interim pieces that grow into one final. */
const CAPTION_INTERIM_1 = 'book a';
const CAPTION_INTERIM_2 = 'book a table';

/** How long a `wait` step is parked to hold a run in flight for the queue/interrupt/leave cases. */
const HELD_OFFSET_MS = 240_000;

/**
 * The background boundary the coalescing chain is paced past. The proxy's window is 2.5 s with no env
 * seam, so a gap wider than it is the difference between N separate queued messages and one message
 * made of N pieces — and it is separate messages that push the byte backlog over the budget.
 */
const QUEUE_CALL_GAP_MS = 3_000;
/**
 * One over-budget payload. The refusal is judged on `waiting + this > budget`; each accepted
 * `queued: true` delivery adds its bytes to the waiting total, so with 620-byte messages the bound is
 * crossed on the third call. The exact byte count is NOT asserted — the budget axis belongs to
 * `gap-live-voice-queue-byte-budget-and-visible-backlog`; this file reads only the UI's declared
 * refusal/depth readings.
 */
const QUEUE_MESSAGE_BYTES = 620;
const queueMessage = (index: number): string => `queued instruction ${index} ${'x'.repeat(QUEUE_MESSAGE_BYTES)}`;

/** The row a leave-must-not-abort run writes only after its own clock lets it past the hold. */
const FINAL_TURN_TEXT = 'the held turn finished after the mode was left';

/**
 * The two utterances the interrupt cases are judged on — the fence's `triggerSeq` axis, in words.
 *
 * THE SECOND ONE IS THE WHOLE POINT OF THE CASE. The fence lets a model stop through when the run has
 * NOT already been stopped for the sentence it names (SPEC §0.3 D-7 / §18.4 G2): a stop carries the
 * `utteranceSeq` standing when the model decided, and a call naming a `triggerSeq` this connection
 * has already interrupted for is answered `{stopped: false, reason: 'covered'}` — the debounce, not a
 * second stop. So "the same words, stopped for twice" is the fenced form, and it is a NEW utterance
 * between the two stops that makes the second one a stop at all. With no new words the second call is
 * the debounce, which is exactly the false form the covered case below pins.
 */
const INTERRUPT_WORDS_1 = 'start the held turn';
const INTERRUPT_WORDS_2 = 'no — stop that and take the other direction';

/** The smallest valid scenario — its walk writes nothing; the session is a carrier for the rows. */
const SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: TITLE, userText: SEED_USER_TEXT },
  steps: [{ at: 0, op: 'wait' }],
  expect: { rows: { delta: 0 }, content: { mustContain: [SEED_USER_TEXT] } },
};

/**
 * A walk that sleeps to a far offset, so a run it opens HOLDS the session's turn lease open.
 *
 * `steps[].at` is milliseconds from the START OF THE RUN (the engine's clock), and a run starts when
 * the first `session_send` reaches the session — not when the scenario is armed. `writeAtMs === null`
 * parks the walk far out so nothing is ever written; a number writes one assistant row there.
 */
const heldScenario = (title: string, seedText: string, writeAtMs: number | null, text: string) => ({
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title, userText: seedText },
  steps: [
    { at: 0, op: 'wait' },
    writeAtMs === null
      ? { at: HELD_OFFSET_MS, op: 'wait' }
      : { at: writeAtMs, op: 'row', role: 'assistant', text },
  ],
  expect:
    writeAtMs === null
      ? { rows: { delta: 0 }, content: { mustContain: [seedText] } }
      : { rows: { delta: 1 }, content: { mustContain: [seedText, text] } },
});

// ---------------------------------------------------------------------------------------------
// The page helpers — the same shapes the four sibling voice specs use.
// ---------------------------------------------------------------------------------------------

const projectRow = (page: Page, workspaceName: string) =>
  page
    .getByRole('button', { name: new RegExp(`^${workspaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) })
    .first();

const sessionRow = (page: Page, sessionId: string): ReturnType<Page['locator']> =>
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

const phase = async (page: Page): Promise<string> =>
  ((await page.getByTestId('voice-realtime-phase').textContent()) ?? '').trim();

const waitForPhase = (page: Page, wanted: string) =>
  expect.poll(() => phase(page), { timeout: 25_000 }).toBe(wanted);

/** The transcript's own text, read straight off the pane. */
const paneText = (page: Page): Promise<string> => page.locator(PANE).innerText();

/** Every user row's spoken text, in order — the caption fold is read off this. */
const userRowProse = (page: Page): Promise<string[]> =>
  page.locator(USER_ROW_PROSE).evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? '').trim()));

/** Writes a screenshot when QUAY_LIVE_VOICE_SHOT_DIR is set; a no-op in ordinary runs. */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.QUAY_LIVE_VOICE_SHOT_DIR;
  if (dir) await page.waitForTimeout(700);
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

/** Enters Live Voice and waits for the bar to have replaced the composer. */
async function enterLiveVoice(page: Page): Promise<void> {
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 30_000 });
  const entry = page.getByTestId('live-voice-button');
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await entry.click();
  await expect(page.getByTestId('voice-realtime-bar')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeHidden();
}

/** Leaves Live Voice and waits for the composer to come back. */
async function leaveLiveVoice(page: Page): Promise<void> {
  await page.getByTestId('voice-realtime-end').click();
  await expect(page.locator(BAR)).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 15_000 });
}

/** Navigates to a session and waits for its pane and composer. */
async function openSession(page: Page, sessionId: string): Promise<void> {
  await page.goto(`/session/${sessionId}`);
  await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 30_000 });
}

/**
 * Has the endpoint close an utterance with `text`, and waits until the bar is showing those words.
 *
 * THE WAIT IS THE ORDERING BARRIER, and it is a reading rather than a sleep. The proxy answers a
 * final transcription in ONE synchronous step — it sends the `caption` frame to the page and counts
 * the utterance (`utteranceSeq`, the fence's `triggerSeq`) in the same block — so a page that is
 * already rendering those words is proof the count has happened, and the interrupt the case emits
 * next is fenced against the utterance it was meant to be fenced against.
 *
 * The `itemId` has to be a NEW one per utterance: the page keys captions by it, so re-using an id
 * REPLACES the earlier words instead of arriving as a second utterance.
 */
async function hearUtterance(
  page: Page,
  upstream: ScriptedUpstreamServer,
  itemId: string,
  text: string,
): Promise<void> {
  upstream.emit(captionCompleted(itemId, text));
  await expect(page.getByTestId('voice-realtime-caption')).toContainText(text, { timeout: 15_000 });
}

/** The parsed `output` of the tool result the app returned for `callId`, or `null`. */
function toolOutputFor(upstream: ScriptedUpstreamServer, callId: string): Record<string, unknown> | null {
  for (const entry of upstream.functionCallOutputs()) {
    const item = entry.item as Record<string, unknown> | undefined;
    if (item?.call_id !== callId) continue;
    const raw = item.output;
    if (typeof raw !== 'string') continue;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

const isLoopbackUrl = (url: string): boolean =>
  /^(wss?|https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);

// ---------------------------------------------------------------------------------------------
// The fake audio graph. No CI machine has a microphone, so the browser's capture is an inert graph;
// nothing in this file pushes PCM into it (every scenario here is driven by the scripted upstream).
// ---------------------------------------------------------------------------------------------

function installFakeAudioGraph(): void {
  type Port = { onmessage: ((m: unknown) => void) | null; postMessage: () => void };
  class FakeWorkletNode {
    port: Port;
    constructor() {
      this.port = { onmessage: null, postMessage: () => undefined };
    }

    connect() {
      /* inert */
    }
  }
  /**
   * The capture `AudioContext`, carrying the `state` / `statechange` / `resume()` the microphone
   * source reacts to (this task). `resume()` is deliberately ASYNCHRONOUS: it parks a completion the
   * page-side helper below drives, so a test can observe the suspended state for a beat before
   * capture is live again — a resume that returned synchronously would clear the suspension inside
   * the same task and the greyed waveform would never be renderable.
   */
  class FakeAudioContext {
    static readonly contexts: FakeAudioContext[] = [];
    sampleRate = 16_000;
    destination = {};
    state = 'running';
    audioWorklet = { addModule: async () => undefined };
    private readonly stateChangeListeners: Array<() => void> = [];
    private completeResume: (() => void) | null = null;
    constructor() {
      FakeAudioContext.contexts.push(this);
    }

    createGain() {
      return { gain: { value: 0 }, connect: () => undefined };
    }

    createMediaStreamSource() {
      return { connect: () => undefined };
    }

    close() {
      return Promise.resolve();
    }

    addEventListener(type: string, listener: () => void) {
      if (type === 'statechange') this.stateChangeListeners.push(listener);
    }

    /** Whether anything (i.e. the microphone source) is watching this context's state. */
    hasStateChangeListener(): boolean {
      return this.stateChangeListeners.length > 0;
    }

    /** Moves the context to `state` and fires the listeners, exactly as a browser would. */
    private setState(state: string) {
      this.state = state;
      for (const listener of this.stateChangeListeners) listener();
    }

    /** The browser's own suspend — what a notification sound or a Bluetooth route change causes. */
    suspend() {
      this.setState('suspended');
    }

    /** The resume the source asks for; async, completed only when the helper below says so. */
    resume() {
      return new Promise<void>((resolve) => {
        this.completeResume = () => {
          this.setState('running');
          resolve();
        };
      });
    }

    /** Completes a parked resume: state back to `running`, then the `statechange`. */
    completeResumeNow() {
      this.completeResume?.();
      this.completeResume = null;
    }
  }

  /** The live capture context — the most recent one that has a state watcher, never a notification one. */
  const captureContext = (): FakeAudioContext | undefined =>
    [...FakeAudioContext.contexts].reverse().find((context) => context.hasStateChangeListener());

  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  (window as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = FakeWorkletNode;
  // The one handle the test has on the app-constructed context: suspend it, or complete the resume
  // the source asked for. Named on `window` because the fake lives in the app's own object graph.
  (window as unknown as { __voiceFakeAudio: unknown }).__voiceFakeAudio = {
    suspend: () => captureContext()?.suspend(),
    resume: () => captureContext()?.completeResumeNow(),
    hasCaptureContext: () => captureContext() !== undefined,
  };
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }) },
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('voice realtime on the shared scripted upstream', () => {
  let page: Page;
  let api: APIRequestContext;
  let upstream: ScriptedUpstreamServer;
  let workspacePath = '';
  let workspaceName = '';
  let sessionId = '';

  /** Every non-loopback URL the PAGE reached, so "no outbound" is a reading rather than a claim. */
  const nonLoopbackRequests: string[] = [];
  const nonLoopbackWebSockets: string[] = [];
  /** Every `chat.abort` frame the page put on a socket — the running row's Stop, observed. */
  const chatAbortFrames: string[] = [];
  /**
   * Every `stopped` frame the SERVER put on a socket the page holds — one per model stop that the
   * fence let through.
   *
   * WHY THE WIRE AND NOT THE DOM. Since `gap-voice-ui-strip-to-caption-and-connection-state`
   * (2026-10-14) the bar draws no per-stop node at all, so the DOM has nothing to count. The fence's
   * whole observable effect is "a `stopped` frame, or none", which is a frame count, so that is what
   * is read here — the same reading the `chat.abort` array above takes from the other direction.
   */
  const stoppedFrames: string[] = [];

  test.beforeAll(async ({ browser }) => {
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');
    const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
    if (!fixtureHome) throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME');
    const upstreamPort = Number(process.env.QUAY_E2E_VOICE_REALTIME_PORT);
    if (!Number.isInteger(upstreamPort) || upstreamPort <= 0) {
      throw new Error('playwright.config.ts must publish QUAY_E2E_VOICE_REALTIME_PORT for this selection');
    }

    upstream = await startScriptedUpstream(upstreamPort);

    workspacePath = path.join(fixtureHome, 'voice-realtime-workspace');
    workspaceName = path.basename(workspacePath);

    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();

    api = await request.newContext({ baseURL: clientUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
    sessionId = await armScenario(api, workspacePath, SCENARIO);

    const context = await browser.newContext({ baseURL: clientUrl, viewport: { width: 1280, height: 800 } });
    await context.addInitScript(
      ({ authToken }: { authToken: string }) => {
        window.localStorage.setItem('auth-token', authToken);
        window.localStorage.setItem('userLanguage', 'en');
        const preferences = { voiceEnabled: true };
        window.localStorage.setItem('uiPreferences', JSON.stringify(preferences));
        window.localStorage.setItem(
          'user-preferences',
          JSON.stringify({ uiPreferences: preferences, userLanguage: 'en' }),
        );
      },
      { authToken: token },
    );
    await context.addInitScript(installFakeAudioGraph);

    page = await context.newPage();
    // The outbound reading (AC2): every URL the page reaches that is not loopback, and every socket it
    // opens, recorded from the first byte the page loads. The page DOES pull its two pinned Google-Fonts
    // stylesheets — the case below accounts for exactly those and nothing else.
    page.on('request', (r) => {
      const url = r.url();
      if (!isLoopbackUrl(url)) nonLoopbackRequests.push(url);
    });
    page.on('websocket', (ws) => {
      const url = ws.url();
      if (!isLoopbackUrl(url)) nonLoopbackWebSockets.push(url);
      ws.on('framesent', (frame) => {
        // A frame Playwright cannot decode must not tear the page down: this observer is a reading,
        // never a participant.
        try {
          const payload = frame.payload;
          const text = typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8');
          if (text.includes('chat.abort')) chatAbortFrames.push(text);
        } catch {
          /* not a frame this reading can decode — ignore */
        }
      });
      // The server → page direction, for the one frame a model stop is: `stopped`. Decoded rather
      // than substring-matched, so an instruction or a caption that happens to carry the word cannot
      // be counted as a stop.
      ws.on('framereceived', (frame) => {
        try {
          const payload = frame.payload;
          const text = typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8');
          if ((JSON.parse(text) as { type?: unknown }).type === 'stopped') stoppedFrames.push(text);
        } catch {
          /* not a frame this reading can decode — ignore */
        }
      });
    });
    await page.route('**/api/voice/health', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true }) }),
    );

    await page.goto('/');
    if (
      !(await projectRow(page, workspaceName)
        .waitFor({ state: 'visible', timeout: 25_000 })
        .then(() => true, () => false))
    ) {
      await page.reload();
    }
    await revealSession(page, workspaceName, sessionId);
    await sessionRow(page, sessionId).click();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    await page?.close();
    await api?.dispose();
    await upstream?.close();
  });

  /**
   * AC1 (green form) + AC2 — the app dials the scripted LOCAL upstream, carrying no cloud credential,
   * and nothing on the voice path leaves the loopback.
   *
   * AC1's FALSE form is this same case with `VOICE_REALTIME_ENDPOINT` withheld from this selection: the
   * transport then has no socket factory and an empty key, refuses with `MISSING_API_KEY`, no dial is
   * made and `waitForPhase('listening')` never settles — the case reds at its first reading. That
   * red/green pair is recorded in the task's Evidence; it is a run-level configuration change, not
   * something the case can flip on itself.
   */
  test('the app dials the scripted local upstream with no cloud credential, and the voice path never leaves the loopback', async () => {
    await openSession(page, sessionId);
    await enterLiveVoice(page);
    await waitForPhase(page, 'listening');

    // The dial really happened, and it really came HERE: the session cannot reach `listening` against
    // a server that never answered a handshake.
    await expect.poll(() => upstream.dialed(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    await expect.poll(() => upstream.liveConnectionCount(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);

    // AC2, the RUNTIME half: the credential the transport carried. `DASHSCOPE_API_KEY` is the empty
    // string for this selection, so the transport dials with `{}` — there is no `authorization` header
    // to find. A run that somehow had a real key is exactly what this must not see.
    const headers = upstream.upgradeHeaders();
    expect(headers.length, 'no upgrade request was recorded').toBeGreaterThanOrEqual(1);
    expect(
      Object.keys(headers[0]!).map((key) => key.toLowerCase()).includes('authorization'),
      `the upgrade carried a credential: ${JSON.stringify(headers[0])}`,
    ).toBe(false);

    // The "no outbound" reading, scoped to what the voice path could reach. The Realtime channel is a
    // WebSocket, so a cloud dial from the PAGE would be a non-loopback WebSocket — the page opened
    // none (the server-side dial is separately pinned: it landed on OUR listener, `dialed >= 1`).
    expect(nonLoopbackWebSockets, `the page opened a non-loopback socket: ${nonLoopbackWebSockets.join(', ')}`).toEqual(
      [],
    );
    // For HTTP, the page's own chrome is the only non-loopback traffic there should be: the two
    // Google-Fonts hosts `index.html` pins, and the star badge / updater's `api.github.com` fetches.
    // None is the voice path, and an allow-list is the honest shape here — any OTHER host (a
    // DashScope or cloud-AI endpoint among them) fails this line.
    const CHROME_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com', 'api.github.com']);
    const strayHosts = [...new Set(nonLoopbackRequests.map((url) => new URL(url).host))].filter(
      (host) => !CHROME_HOSTS.has(host),
    );
    expect(strayHosts, `a non-loopback host outside the page's own chrome: ${strayHosts.join(', ')}`).toEqual([]);
    // Non-vacuity: the observer really saw the page's own chrome fetch, so the empty lists above are a
    // reading rather than a dead listener.
    expect(
      nonLoopbackRequests.length,
      'the outbound observer recorded nothing at all — it cannot certify an absent dial',
    ).toBeGreaterThan(0);
    await shot(page, 'scripted-upstream-dial-and-credential');

    await leaveLiveVoice(page);
  });

  /**
   * AC3 + AC2's SOURCE half — the vocabulary and the cloud guard are DECLARED, read off the files.
   *
   * The helper may not define a second set of builders: it must IMPORT them, and a redefinition would
   * be a second source of truth that drifts the moment the module changes. And on the credential side,
   * the guard must be visible in the selection itself rather than assumed — this run's env spread has to
   * carry both the endpoint it points at and the empty-string key that overrides an ambient one.
   */
  test('the shared upstream re-uses the server builder module, and the cloud guard is declared in the selection', async () => {
    const BUILDERS = [
      'captionDelta',
      'captionCompleted',
      'functionCall',
      'endpointError',
      'modelTextReply',
      'transcriptionFailed',
    ];
    const helperSource = readFileSync(path.resolve(process.cwd(), 'e2e/voiceRealtimeScriptedUpstream.ts'), 'utf8');
    expect(helperSource).toContain("from '../server/modules/voice-realtime/tests/voice-realtime-scripted-upstream'");
    const redefined = BUILDERS.filter((name) => new RegExp(`function\\s+${name}\\s*\\(`).test(helperSource));
    expect(redefined, `the helper must not redefine: ${redefined.join(', ')}`).toEqual([]);

    const serverSource = readFileSync(
      path.resolve(process.cwd(), 'server/modules/voice-realtime/tests/voice-realtime-scripted-upstream.ts'),
      'utf8',
    );
    const serverDefinitions = BUILDERS.filter((name) => new RegExp(`export function\\s+${name}\\s*\\(`).test(serverSource));
    expect(
      serverDefinitions.length,
      `the one vocabulary must define every builder: ${serverDefinitions.join(', ')}`,
    ).toBe(BUILDERS.length);

    // AC2's SOURCE half: the guard is declared, not assumed. The selection's own env spread must carry
    // both the endpoint this run points at and the empty-string credential that overrides an ambient one.
    const configSource = readFileSync(path.resolve(process.cwd(), 'playwright.config.ts'), 'utf8');
    const voiceEnvSpread = configSource.slice(configSource.indexOf('...(voiceRealtimeSelection'));
    expect(voiceEnvSpread, "the selection's env spread must be in playwright.config.ts").toContain(
      'VOICE_REALTIME_ENDPOINT',
    );
    expect(voiceEnvSpread, 'the cloud credential must be blanked on this selection').toContain("DASHSCOPE_API_KEY: ''");
  });

  /**
   * AC5 — one utterance's captions fold into ONE row, in place.
   *
   * The endpoint streams an interim caption, UPDATES it in place (same `item_id`), closes it with a
   * final carrying the settled words, and then emits a wordless final for an utterance that was never
   * on screen. What the person must read: one row whose words grew to the final text, no blank row,
   * and no fossilised copy of the interim.
   */
  test('interim captions fold into one row that settles in place, with no blank final and no duplicate', async () => {
    await openSession(page, sessionId);
    await enterLiveVoice(page);
    await waitForPhase(page, 'listening');

    const before = await userRowProse(page);
    expect(before, 'the seed row must be there before the captions').toContain(SEED_USER_TEXT);

    await upstream.script([
      { wire: captionDelta('item-caption', CAPTION_INTERIM_1), afterMs: 0 },
      { wire: captionDelta('item-caption', CAPTION_INTERIM_2), afterMs: 400 },
      { wire: captionCompleted('item-caption', CAPTION_INTERIM_2), afterMs: 400 },
      // A wordless closure for an utterance that never had a row: dropped at source, never a blank row.
      { wire: captionCompleted('item-caption-blank', ''), afterMs: 300 },
    ]);

    // The row settles in place: one row, carrying the final words.
    await expect
      .poll(async () => (await userRowProse(page)).filter((text) => text === CAPTION_INTERIM_2).length, {
        timeout: 15_000,
      })
      .toBe(1);

    const prose = await userRowProse(page);
    // No blank row: the wordless closure minted nothing.
    expect(prose.filter((text) => text === ''), `a blank user row was rendered: ${JSON.stringify(prose)}`).toEqual([]);
    // One row for the utterance: the interim never became a row of its own, so exactly one row mentions
    // the words at all (the interim would have been a second one).
    expect(
      prose.filter((text) => text.includes('book')),
      `the interim was fossilised as its own row: ${JSON.stringify(prose)}`,
    ).toHaveLength(1);
    // And the rows on screen are the seed row plus that one — nothing else was minted.
    expect(prose.length, `unexpected user rows: ${JSON.stringify(prose)}`).toBe(before.length + 1);

    // The settled utterance is on screen as `heard` — nothing is in flight, so nothing reads `delivering`.
    await expect(page.getByTestId('voice-row-heard')).toHaveCount(1);
    await expect(page.getByTestId('voice-row-delivering')).toHaveCount(0);
    await shot(page, 'scripted-upstream-caption-fold');

    await leaveLiveVoice(page);
  });

  /**
   * AC4 — over the queue's upper bound, the page shows the proxy's own refusal AND its depth reading.
   *
   * A held run parks the session's turn lease open, so the session answers each further instruction
   * with `queued: true` and the relay's waiting-byte total grows. The chain is paced past the 2.5 s
   * coalescing window so each instruction is its own queued message; the third crosses the budget and
   * the proxy answers `refused`. NO THRESHOLD OF THE BUDGET AXIS IS ASSERTED — only the readings the UI
   * declares.
   */
  test('an instruction over the queue bound is refused, and the page shows the depth reading', async () => {
    const heldId = await armScenario(
      api,
      workspacePath,
      heldScenario('Voice queue arm', 'the held run behind the queue refusal', null, ''),
    );
    await openSession(page, heldId);
    await enterLiveVoice(page);
    await waitForPhase(page, 'listening');

    const status = page.getByTestId('voice-realtime-status');
    const outputsBefore = upstream.functionCallOutputs().length;
    // The chain is paced on the app's OWN acknowledgement: the relay answers a coalesced call the
    // instant it accepts it, so waiting for each tool result is what keeps consecutive calls from
    // landing inside one window and being joined into one message.
    for (let index = 0; index < 5; index += 1) {
      upstream.emit(functionCall('session_send', { message: queueMessage(index) }, `queue-call-${index}`));
      await expect
        .poll(() => upstream.functionCallOutputs().length, { timeout: 20_000 })
        .toBeGreaterThanOrEqual(outputsBefore + index + 1);
      await page.waitForTimeout(QUEUE_CALL_GAP_MS);
    }

    // The refusal is on screen, with the proxy's own reason code...
    await expect.poll(() => status.getAttribute('data-refusal'), { timeout: 20_000 }).toBe('queue-full');
    // ...and the depth reading beside it is the proxy's count, not a number this file computed.
    const depth = Number((await status.getAttribute('data-queued-depth')) ?? '0');
    expect(Number.isFinite(depth), `data-queued-depth was not a number: ${depth}`).toBe(true);
    expect(depth, 'the refusal must leave a wait behind it to be visible').toBeGreaterThanOrEqual(1);
    await shot(page, 'scripted-upstream-queue-refused');

    await leaveLiveVoice(page);
  });

  /**
   * AC6 — moving the pane to another session ends the Live Voice connection.
   *
   * The same reading the sibling spec takes, on the shared upstream. One extra reading pins "no
   * duplicate delivery": the dial count the upstream saw never grows, so the ended connection was not
   * re-opened and nothing was relayed a second time.
   */
  test('moving the pane to another session ends the Live Voice connection', async () => {
    await openSession(page, sessionId);
    await enterLiveVoice(page);
    await waitForPhase(page, 'listening');
    await expect.poll(() => upstream.liveConnectionCount(), { timeout: 15_000 }).toBe(1);
    const dialsBefore = upstream.dialed();

    await page.getByRole('button', { name: /new session/i }).first().click();
    await expect(page.locator(BAR)).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => upstream.liveConnectionCount(), { timeout: 15_000 }).toBe(0);
    expect(upstream.dialed(), 'the ended connection must not be re-opened').toBe(dialsBefore);
    await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 15_000 });
  });

  /**
   * AC7 — a scripted STOP reaches the session, and the wire carries what the stop left behind.
   *
   * The upstream hears an utterance, relays an instruction that opens a HELD run, then relays
   * `session_interrupt` — the model's own stop verb. Three readings: the proxy's `stopped` frame
   * arrives (carrying the backlog depth, which the bar's removed copy used to read out), the app
   * really returned the interrupt's tool result to the upstream, and the frame count on the wire
   * really grew by one.
   *
   * AND THEN IT STOPS AGAIN, WHICH IS THE FENCE'S OWN CASE. The call carries the voice plane's
   * mandatory `intent` (SPEC §6.2: a stop is a judgement, so what the model took the user to want has
   * to be on the record — a call without one is refused by the argument schema before any stop path
   * is reached, which is what left this case red with no frame and no tool result at all). The second
   * stop is emitted only AFTER the endpoint closes a second utterance: the fence answers a call whose
   * `triggerSeq` this connection has already interrupted for `{stopped: false, reason: 'covered'}`,
   * so new words are what make the second call a stop rather than the debounce. Removing that second
   * utterance is the case's false form, recorded in this task's Notes.
   *
   * WHY `aborted` IS NOT ASSERTED TRUE: this is a debug-agent session and its provider's `abort()`
   * reports false by construction (a scenario is a clock walk over a file — no child process to tear
   * down), so the control service correctly answers `aborted: false`. The session RECEIVING the stop is
   * what the `stopped` frame is — the same reading `gap-live-voice-voice-terminated-interrupt`'s own
   * criterion takes — and asserting `aborted` here would be asserting the substitute's nature, not the
   * proxy's behaviour.
   */
  test('a scripted interrupt reaches the session and the page reports the backlog it left', async () => {
    const heldId = await armScenario(
      api,
      workspacePath,
      heldScenario('Voice interrupt arm', 'the held run the stop ends', null, ''),
    );
    await openSession(page, heldId);
    await enterLiveVoice(page);
    await waitForPhase(page, 'listening');

    // The sentence the FIRST stop is for. `triggerSeq` counts final transcriptions, so without this
    // the stop would carry no utterance at all.
    await hearUtterance(page, upstream, 'interrupt-heard-1', INTERRUPT_WORDS_1);

    upstream.emit(functionCall('session_send', { message: INTERRUPT_WORDS_1 }, 'interrupt-start'));
    // The run is in flight once the client's own poll has observed it — the Stop is that observation.
    await expect(page.getByTestId('running-turn-stop')).toBeVisible({ timeout: 30_000 });

    const stoppedBefore = stoppedFrames.length;
    upstream.emit(
      functionCall(
        'session_interrupt',
        { intent: 'the user asked for the run in flight to stop', heard: INTERRUPT_WORDS_1 },
        'interrupt-stop',
      ),
    );

    // The bar draws no stop notice any more (the strip, 2026-10-14), so the reading the removed copy
    // used to carry — "the stop did NOT throw the backlog away" — is taken where it always lived: on
    // the proxy's own `stopped` frame, whose `depth` is the count that copy interpolated. The absence
    // half is read by PREFIX, so a notice coming back under a new name fails here too.
    await expect(page.locator(STOP_NOTICE_PREFIX)).toHaveCount(0);
    // The interrupt really executed: the app returned its result to the upstream, and the receipt
    // names the utterance the judgement was made on rather than an invented one.
    await expect.poll(() => toolOutputFor(upstream, 'interrupt-stop') !== null, { timeout: 15_000 }).toBe(true);
    const firstStop = toolOutputFor(upstream, 'interrupt-stop');
    expect(firstStop?.triggerSeq, `the first stop's receipt: ${JSON.stringify(firstStop)}`).toBe(1);
    expect(firstStop?.reason, `a stop that ran is not a covered one: ${JSON.stringify(firstStop)}`).toBeUndefined();
    await expect.poll(() => stoppedFrames.length, { timeout: 15_000 }).toBe(stoppedBefore + 1);
    // The frame the page was handed really carries the backlog count — the field the removed status
    // copy read out. The magnitude is NOT asserted: the copy said "{{depth}} still queued" at any
    // depth, so pinning a number here would be inventing a reading this arm never made.
    const firstStopFrame = JSON.parse(stoppedFrames[stoppedBefore]) as { depth?: unknown };
    expect(
      typeof firstStopFrame.depth,
      `the stop frame's own depth reading: ${stoppedFrames[stoppedBefore]}`,
    ).toBe('number');
    await shot(page, 'scripted-upstream-interrupt-stopped');

    // The person speaks AGAIN — a NEW utterance, and the only thing that lets a second stop through
    // the fence: the sentence this one names has not been interrupted for yet.
    await hearUtterance(page, upstream, 'interrupt-heard-2', INTERRUPT_WORDS_2);

    upstream.emit(
      functionCall(
        'session_interrupt',
        { intent: 'the user changed direction', heard: INTERRUPT_WORDS_2 },
        'interrupt-stop-again',
      ),
    );
    await expect.poll(() => stoppedFrames.length, { timeout: 20_000 }).toBe(stoppedBefore + 2);
    await expect
      .poll(() => toolOutputFor(upstream, 'interrupt-stop-again') !== null, { timeout: 15_000 })
      .toBe(true);
    const secondStop = toolOutputFor(upstream, 'interrupt-stop-again');
    expect(secondStop?.triggerSeq, `the second stop's receipt: ${JSON.stringify(secondStop)}`).toBe(2);
    expect(secondStop?.reason, `new words are not covered: ${JSON.stringify(secondStop)}`).toBeUndefined();

    await leaveLiveVoice(page);
  });

  /**
   * AC3 — the fence's other half, pinned: a repeat with NO new words is `covered`, never a second stop.
   *
   * The same setup as AC7's first half, and then the SAME call again with nothing said in between.
   * The fence answers it `{stopped: false, reason: 'covered'}` — the debounce D-7 exists to forbid —
   * and, which is the reading that matters to a person, puts NO second `stopped` frame on the wire: a
   * page told "stopped" twice for one sentence would read a debounce as a stop that happened.
   *
   * The frame count is read rather than the DOM because the bar draws no per-stop node at all any more
   * (the strip, 2026-10-14), so "no stop frame for THIS call" is exactly "the count did not move".
   */
  test('a repeated interrupt with no new words is answered covered, not a second stop', async () => {
    const heldId = await armScenario(
      api,
      workspacePath,
      heldScenario('Voice covered arm', 'the held run the covered stop leaves alone', null, ''),
    );
    await openSession(page, heldId);
    await enterLiveVoice(page);
    await waitForPhase(page, 'listening');

    await hearUtterance(page, upstream, 'covered-heard-1', INTERRUPT_WORDS_1);

    upstream.emit(functionCall('session_send', { message: INTERRUPT_WORDS_1 }, 'covered-start'));
    await expect(page.getByTestId('running-turn-stop')).toBeVisible({ timeout: 30_000 });

    // The stop that DOES run: the sentence has not been interrupted for on this connection yet.
    const stoppedBefore = stoppedFrames.length;
    upstream.emit(
      functionCall('session_interrupt', { intent: 'the user asked for the run to stop' }, 'covered-stop-1'),
    );
    await expect.poll(() => stoppedFrames.length, { timeout: 20_000 }).toBe(stoppedBefore + 1);
    await expect.poll(() => toolOutputFor(upstream, 'covered-stop-1') !== null, { timeout: 15_000 }).toBe(true);

    // And now the same call with NOTHING said in between: the same `triggerSeq`, already run.
    upstream.emit(
      functionCall('session_interrupt', { intent: 'the user asked for the run to stop' }, 'covered-stop-2'),
    );
    await expect.poll(() => toolOutputFor(upstream, 'covered-stop-2') !== null, { timeout: 20_000 }).toBe(true);
    const covered = toolOutputFor(upstream, 'covered-stop-2');
    expect(covered?.stopped, `the covered receipt: ${JSON.stringify(covered)}`).toBe(false);
    expect(covered?.reason, `the covered receipt: ${JSON.stringify(covered)}`).toBe('covered');
    expect(covered?.triggerSeq, `it still names the utterance it was for: ${JSON.stringify(covered)}`).toBe(1);
    // The receipt is answered without touching the wire, so one settle boundary is enough to read
    // "no second frame": the covered path returns BEFORE any `send`, and every later frame on this
    // socket would have to come after the result the upstream already holds.
    await page.waitForTimeout(2_000);
    expect(
      stoppedFrames.length,
      `the covered call added a stop frame: ${stoppedFrames.slice(stoppedBefore + 1).join(' | ')}`,
    ).toBe(stoppedBefore + 1);

    await leaveLiveVoice(page);
  });

  /**
   * AC8 (leave half) — leaving Live Voice does NOT abort the run, and the two controls are told apart.
   *
   * A held run is opened behind the bar; while it is in flight the leave control's shape is read from
   * the DOM (a leaving glyph, never the Stop's own square, and the word `Exit`), and the closing row is
   * absent. Clicking Exit then takes the mode away — and puts ZERO `chat.abort` frames on the wire —
   * and the row lands afterwards, on the run's own clock: only a run that outlived the leave can
   * produce that order.
   */
  test('leaving Live Voice does not abort the run, and no abort frame is sent', async () => {
    const heldId = await armScenario(
      api,
      workspacePath,
      heldScenario('Voice leave arm', 'the held run the leave must not end', 20_000, FINAL_TURN_TEXT),
    );
    await openSession(page, heldId);
    await enterLiveVoice(page);
    await waitForPhase(page, 'listening');

    upstream.emit(functionCall('session_send', { message: 'start the turn the leave must not end' }, 'leave-start'));
    const stop = page.getByTestId('running-turn-stop');
    await expect(stop).toBeVisible({ timeout: 30_000 });
    const leave = page.getByTestId('voice-realtime-end');
    await expect(leave).toBeVisible();

    const stopIcon = (await stop.locator('svg').getAttribute('class')) ?? '';
    const leaveIcon = (await leave.locator('svg').getAttribute('class')) ?? '';
    expect(stopIcon, `the running row's Stop draws the stop glyph: "${stopIcon}"`).toContain('square');
    expect(leaveIcon, `the leave control draws a leaving glyph: "${leaveIcon}"`).toContain('log-out');
    expect(leaveIcon, "the leave control must not draw the Stop's own glyph").not.toContain('square');
    await expect(page.getByTestId('voice-realtime-exit-label')).toHaveCount(0);
    await shot(page, 'scripted-upstream-leave-vs-stop');

    // The run is still inside its hold, so its closing row is not on screen yet.
    expect(await paneText(page), 'the held run wrote its closing row before the leave').not.toContain(FINAL_TURN_TEXT);

    const abortsBefore = chatAbortFrames.length;
    await leaveLiveVoice(page);
    expect(
      chatAbortFrames.length,
      `leaving sent an abort frame: ${chatAbortFrames.slice(abortsBefore).join(' | ')}`,
    ).toBe(abortsBefore);
    // The row lands on the run's OWN clock, after the mode was left: the leave did not abort it.
    await expect.poll(() => paneText(page), { timeout: 30_000 }).toContain(FINAL_TURN_TEXT);
  });

  /**
   * AC8 (stop half) — the running row's own Stop DOES issue the session abort.
   *
   * The Stop is clicked while a held run is in flight, and the frame it puts on the app's own socket is
   * read off the wire: exactly one `chat.abort`, naming this session. That is the browser-level form of
   * "the stop key aborts" — the same `chat.abort` the composer's stop button has always sent, NOT a
   * second path. The run itself is not asserted to end: this fixture's provider cannot abort (see AC7's
   * note), so a run that survives the click is the substitute's nature, not a missing stop.
   */
  test("the running row's own Stop issues exactly one session abort", async () => {
    const heldId = await armScenario(
      api,
      workspacePath,
      heldScenario('Voice stop arm', 'the held run the stop must end', null, ''),
    );
    await openSession(page, heldId);
    await enterLiveVoice(page);
    await waitForPhase(page, 'listening');

    upstream.emit(functionCall('session_send', { message: 'start the turn the stop must end' }, 'stop-start'));
    const stop = page.getByTestId('running-turn-stop');
    await expect(stop).toBeVisible({ timeout: 30_000 });

    const abortsBefore = chatAbortFrames.length;
    await stop.click();
    await expect.poll(() => chatAbortFrames.length - abortsBefore, { timeout: 15_000 }).toBe(1);
    // The frame names the session it stops — an abort for some other session would be no stop at all.
    expect(
      chatAbortFrames[abortsBefore],
      `the stop frame did not name the session: ${chatAbortFrames[abortsBefore]}`,
    ).toContain(heldId);
    await shot(page, 'scripted-upstream-stop-aborts');

    await leaveLiveVoice(page);
  });

  /**
   * (this task) AC4 — a browser-forced microphone suspension reaches the REAL page as a greyed
   * waveform with the detail on the console and NO red error line, and clears when capture resumes.
   *
   * WHY THIS IS THE REAL-LANDING EVIDENCE. AC1-AC3 drive the source/hook/bar under jsdom, which is
   * necessary but not sufficient (DIR-026 Reading A). This case runs the SHIPPING microphone capture
   * path in a real browser DOM — only `AudioContext`/`getUserMedia` are faked, the same standing
   * convention every voice-realtime e2e case uses because no CI machine has a microphone — and reads
   * what a person would actually see: the meter greys without the red line, the explanation exists
   * only in the browser console, and a resume really restores the live look.
   */
  test('a suspended microphone greys the waveform and logs the detail without a red error', async () => {
    await openSession(page, sessionId);
    await enterLiveVoice(page);
    await waitForPhase(page, 'listening');

    // The app built a real capture graph (through the fake browser APIs), so there is a context with
    // a state watcher to suspend.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __voiceFakeAudio: { hasCaptureContext: () => boolean } }).__voiceFakeAudio.hasCaptureContext(),
        ),
      )
      .toBe(true);

    const consoleLines: string[] = [];
    const onConsole = (message: ConsoleMessage) => consoleLines.push(message.text());
    page.on('console', onConsole);

    const GREY = '[data-testid="voice-realtime-wave"] > span[class*="bg-muted-foreground/50"]';
    const PRIMARY = '[data-testid="voice-realtime-wave"] > span[class*="bg-primary/70"]';
    // Baseline: the live meter is the primary tone everywhere.
    await expect(page.locator(PRIMARY)).toHaveCount(12);
    await expect(page.locator(GREY)).toHaveCount(0);

    // The browser suspends the capture context on its own — no navigation, no user action.
    await page.evaluate(
      () => (window as unknown as { __voiceFakeAudio: { suspend: () => void } }).__voiceFakeAudio.suspend(),
    );

    // The waveform really greys...
    await expect(page.locator(GREY)).toHaveCount(12);
    await expect(page.locator(PRIMARY)).toHaveCount(0);
    // ...the red error line really does NOT appear...
    await expect(page.getByTestId('voice-realtime-error')).toBeHidden();
    // ...the detail really reached the browser console (and NOT a visible text node)...
    await expect.poll(() => consoleLines.some((line) => line.includes('AudioContext suspended'))).toBe(true);
    await expect(page.locator('[data-testid="voice-realtime-caption"]')).not.toContainText('AudioContext');
    // ...and the Mute control was not flipped by a suspension the user never asked for.
    await expect(page.getByTestId('voice-realtime-mute')).toHaveAttribute('aria-pressed', 'false');
    await shot(page, 'scripted-upstream-mic-suspended');

    // The source's resume completes: capture is live again and the meter returns to its live look.
    await page.evaluate(
      () => (window as unknown as { __voiceFakeAudio: { resume: () => void } }).__voiceFakeAudio.resume(),
    );
    await expect(page.locator(GREY)).toHaveCount(0);
    await expect(page.locator(PRIMARY)).toHaveCount(12);
    await expect(page.getByTestId('voice-realtime-error')).toBeHidden();

    page.off('console', onConsole);
    await leaveLiveVoice(page);
  });

  /**
   * DoD (gap-live-voice-caption-attribution-swallows-undelivered) — a phrase the model never forwards
   * survives the leave IN THE COMPOSER, instead of being swallowed by the next delivery.
   *
   * The endpoint recognises a phrase; the model never calls `session_send` for it. A LATER delivery
   * relaying DIFFERENT words used to claim every finished utterance still unclaimed, so the phrase
   * looked delivered: it never reached the composer, and its row was dropped at the moment the real
   * message landed. Here the delivery's own message names only the forwarded utterance, so the phrase
   * must stay on screen through the delivery and be re-homed into the composer on the leave.
   */
  test('a phrase the model never forwards stays on its row and re-homes into the composer on leave', async () => {
    await openSession(page, sessionId);
    await enterLiveVoice(page);
    await waitForPhase(page, 'listening');

    /** The utterance the model will relay, verbatim. */
    const FORWARDED = '把 server 的日志贴出来';
    /** The phrase the model recognises but never forwards — the leave's backlog. */
    const DROPPED = '这句话没有被转发出去';

    // The dropped phrase is FINAL before the delivery arrives — exactly the swallowing shape.
    upstream.emit(captionCompleted('item-dropped', DROPPED));
    await expect.poll(() => userRowProse(page).then((rows) => rows.some((text) => text.includes(DROPPED)))).toBe(true);

    // Then a delivery relaying a DIFFERENT utterance, whose message names only that one.
    const outputsBefore = upstream.functionCallOutputs().length;
    upstream.emit(captionCompleted('item-forwarded', FORWARDED));
    await expect.poll(() => userRowProse(page).then((rows) => rows.some((text) => text.includes(FORWARDED)))).toBe(true);
    upstream.emit(functionCall('session_send', { message: FORWARDED }, 'forwarded-call'));
    // The app answers the tool call as soon as the proxy HAS the instruction, not when it delivers it:
    // measured on this tree and on develop, the result is back ~100 ms in, while the relay's window is
    // still open. This asserts the app answered — it is NOT the barrier below.
    await expect.poll(() => upstream.functionCallOutputs().length, { timeout: 20_000 }).toBeGreaterThan(outputsBefore);
    // THE BARRIER: the delivery has to LAND before the leave, and the page is the thing that says so.
    // The relay holds the instruction in its coalescing window first, so the row it was handed reads
    // `delivering`; the `sent` frame is what clears it. Leaving inside that window closes the socket
    // before `sent` can reach the page, and an utterance the relay really did deliver would then be
    // re-homed into the composer as never-sent — the one thing this case forbids.
    await expect(page.getByTestId('voice-row-delivering')).toHaveCount(1);
    await expect(page.getByTestId('voice-row-delivering')).toHaveCount(0);

    // The dropped phrase is STILL on its caption row: the delivery did not take words its message lacks.
    await expect(page.getByTestId('voice-row-heard')).toContainText(DROPPED);
    await shot(page, 'caption-attribution-dropped-still-on-row');

    // Leaving re-homes exactly the dropped phrase, and never the delivered one.
    await leaveLiveVoice(page);
    const draft = await page.locator(COMPOSER_TEXTAREA).inputValue();
    expect(draft, `the composer draft was "${draft}"`).toContain(DROPPED);
    expect(draft, `the delivered utterance must not be re-homed; draft "${draft}"`).not.toContain(FORWARDED);
    await shot(page, 'caption-attribution-draft-rehomed');
  });
});
