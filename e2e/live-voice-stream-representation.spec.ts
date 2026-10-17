/**
 * gap-live-voice-stream-delivery-not-command — the representation + producer criterion, in a real
 * browser, against the real app server, driven by the shared scripted Realtime upstream.
 *
 * WHAT THIS FILE READS, AND WHY A BROWSER IS THE ONLY PLACE IT CAN BE READ:
 *
 *  1. THE PRODUCER IS NOT THE MODEL. Every other Live Voice criterion drives delivery through a
 *     model `session_send` call. Here the scripted endpoint emits a FINAL transcription and then
 *     never opens a response and never calls the tool — the arm that lost 3 of 5 sentences on the
 *     live journal `764f0c7a`. The sentence must still reach the resident session, carrying the
 *     endpoint's own words, because the settle window (`VOICE_SPAN_SETTLE_MS`) is what produces it
 *     now. The `sent` frame is the host's acceptance, and the debug agent's command queue is the
 *     process holding it.
 *  2. THE VOICE DELIVERY IS NOT A COMMAND ROW. The activity snapshot carries the delivery with
 *     `source: 'voice'` (the debug provider publishes its ledger through the same
 *     `publishSessionDeliveries` seam the claude driver uses). A `PendingResidentMessage` row would
 *     draw a [withdraw] button for words that were only ever spoken, so the transcript's
 *     `[data-resident-withdraw]` count must be 0 and no `[data-delivery-id]` row may exist. The
 *     activity frame that DID carry the voice entry is read too, so the zero is a filtering result
 *     and not an empty snapshot.
 *  3. THE READ-ONLY CARD STILL DRAWS. While the relay holds the settled sentence (the session is
 *     busy), the ONE card (`data-testid="voice-pending-message"`) is on screen — the wait is visible,
 *     it just is not a withdrawable command.
 *  4. THE REAL USER MESSAGE APPEARS. The scenario's own clock writes a user turn carrying the same
 *     words after the held turn ends; that row — a normal transcript user row — is what the person
 *     reads, and it carries no withdraw affordance.
 *
 * WHAT IS REAL AND WHAT IS NOT. Real: the browser, the app server, the `/voice-realtime` proxy, the
 * bridge, the live executor, the real `session_send` reaching the real MCP control plane, the debug
 * agent's resident host driver and command queue, the chat websocket, the activity protocol. Not
 * real: the microphone (an init script installs an inert Web Audio graph — every utterance reaches
 * the proxy as the endpoint's own final transcription) and the DashScope endpoint (the app dials the
 * port `playwright.config.ts` points it at, where this file binds its own `ws` server).
 *
 * ⛔ fan-in's suite (`scripts/test.sh`) does not run Playwright. This file self-certifies the DoD and
 * the readings in its `console.log` lines are copied into the task's `## Notes`.
 *
 * Run (the config arms continuous mode + the debug-agent gate for exactly this selection):
 *   bash scripts/with-memory-cap.sh npx playwright test e2e/live-voice-stream-representation.spec.ts
 */
import path from 'node:path';

import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  captionCompleted,
  speechStopped,
  startScriptedUpstream,
  type ScriptedUpstreamServer,
} from './voiceRealtimeScriptedUpstream';

const PANE = '.chat-messages-pane';
const COMPOSER_TEXTAREA = '[data-slot="prompt-input-textarea"]';
const VOICE_BAR = '[data-testid="voice-realtime-bar"]';
/** The ONE read-only card the relay's hold draws (ruling 2026-10-14). */
const HELD_CARD = '[data-testid="voice-pending-message"]';
/** The withdraw control a `PendingResidentMessage` draws for a queued command. */
const WITHDRAW = '[data-resident-withdraw]';
/** The identity the activity channel gives a delivery row. */
const DELIVERY_ROW = '[data-delivery-id]';
/** A normal transcript user message, as `MessageComponent` renders it. */
const USER_ROW = '.chat-message[data-message-style="user"]';

const USERNAME = 'live-voice-stream-e2e';
const PASSWORD = 'live-voice-stream-e2e-pass';

/** What the endpoint heard, verbatim — the text that must reach the session. */
const SPOKEN = '让我们讨论 Live Voice 的进一步改进及语音输出。';
const ITEM_ID = 'stream-item-1';

/** The turn text the walk writes while it holds the session busy. */
const HELD_TURN_TEXT = 'stream criterion held turn';
/** The seed row, so the transcript is not empty before the case starts. */
const SEED_USER_TEXT = 'seeded turn for the stream-representation criterion';

/** Long enough to cover the settle window (2.5 s) plus the busy quiet window (2 s) and the readings. */
const BUSY_SIGNAL_WINDOW_MS = 25_000;
const BUSY_SIGNAL_INTERVAL_MS = 150;

/** The steps that make the relay read BUSY (the activity store's turn phase; see the sibling spec). */
const busySignalSteps = (): Array<{ at: number; op: 'thinking-tokens' }> =>
  Array.from({ length: Math.floor(BUSY_SIGNAL_WINDOW_MS / BUSY_SIGNAL_INTERVAL_MS) }, (_unused, index) => ({
    at: index * BUSY_SIGNAL_INTERVAL_MS,
    op: 'thinking-tokens' as const,
  }));

/**
 * The walk. One held turn (so the host queues the voice send), the phase cadence (so the RELAY reads
 * busy and holds the settled span), then the process acting on the command:
 *   · 12 s — `dequeue`: the substitute takes the held command off its queue;
 *   · 14 s — `turn-end`: the held turn is over;
 *   · 16 s — an unattended turn carrying the spoken words: the REAL user row this criterion ends on.
 */
const STREAM_SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: 'Live voice stream representation arm', userText: SEED_USER_TEXT, lifecycleMode: 'resident' },
  steps: [
    ...[
      { at: 0, op: 'unattended-turn' as const, text: HELD_TURN_TEXT, trigger: 'cron' as const },
      ...busySignalSteps(),
      { at: 12_000, op: 'dequeue' as const },
      { at: 14_000, op: 'turn-end' as const },
      { at: 16_000, op: 'unattended-turn' as const, text: SPOKEN },
      { at: 18_000, op: 'turn-end' as const },
      { at: 240_000, op: 'wait' as const },
    ].sort((left, right) => left.at - right.at),
  ],
  // Two user turns, the busy-signal rows, and the `started` lifecycle row the `dequeue` writes.
  expect: {
    rows: { delta: 2 + busySignalSteps().length + 1 },
    content: { mustContain: [SEED_USER_TEXT, HELD_TURN_TEXT, SPOKEN] },
  },
};

/** A session a walk was armed on: the id the UI addresses it by, and the file the walk writes. */
type ArmedSession = { sessionId: string; transcriptPath: string };

// ---------------------------------------------------------------------------------------------
// Page helpers — the same shapes the sibling voice specs use.
// ---------------------------------------------------------------------------------------------

/**
 * An INERT Web Audio graph. No CI machine has a microphone, and every utterance in this file
 * reaches the proxy as the endpoint's own final transcription, so the capture path only needs to
 * open and produce silence.
 */
const installFakeAudioGraph = () => {
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
  class FakeAudioContext {
    sampleRate = 16_000;
    destination = {};
    state = 'running';
    audioWorklet = { addModule: async () => undefined };
    createGain() {
      return { gain: { value: 0 }, connect: () => undefined };
    }
    createMediaStreamSource() {
      return { connect: () => undefined };
    }
    close() {
      return Promise.resolve();
    }
    addEventListener() {
      /* no state changes are driven by this file */
    }
    resume() {
      return Promise.resolve();
    }
  }
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  (window as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = FakeWorkletNode;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }) },
  });
};

/** Records every JSON frame the app was HANDED on a socket (the activity snapshots included). */
const recordSocketFrames = () => {
  const page = window as unknown as { __socketInbound: unknown[] };
  page.__socketInbound = [];
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      this.addEventListener('message', (event: MessageEvent) => {
        try {
          page.__socketInbound.push(JSON.parse(String(event.data)));
        } catch {
          // Only the JSON frames this protocol uses are of interest.
        }
      });
    }
  } as unknown as typeof WebSocket;
};

const inboundFrames = (page: Page): Promise<Array<Record<string, unknown>>> =>
  page.evaluate(() => (window as unknown as { __socketInbound: Array<Record<string, unknown>> }).__socketInbound ?? []);

type SentDelivery = { text: string; uuid: string | null; deliveryId: string | null };

/** Every `sent` frame the browser was handed, oldest first. */
async function sentDeliveries(page: Page): Promise<SentDelivery[]> {
  const frames = (await inboundFrames(page)).filter((frame) => frame.type === 'sent');
  return frames.map((frame) => {
    const result = (frame.result ?? {}) as Record<string, unknown>;
    return {
      text: typeof frame.message === 'string' ? frame.message : '',
      uuid: typeof result.queuedMessageUuid === 'string' ? result.queuedMessageUuid : null,
      deliveryId: typeof result.deliveryId === 'string' ? result.deliveryId : null,
    };
  });
}

/** Every delivery entry an `activity.*` frame carried, across the whole session history. */
async function activityDeliveries(page: Page): Promise<Array<Record<string, unknown>>> {
  // The activity protocol's frames are keyed by `kind` (the voice proxy's frames use `type`) — the
  // frontend's own handler switches on this field.
  const frames = (await inboundFrames(page)).filter(
    (frame) => frame.kind === 'activity.snapshot' || frame.kind === 'activity.upsert',
  );
  const out: Array<Record<string, unknown>> = [];
  for (const frame of frames) {
    const entries = frame.deliveries;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry === 'object' && entry !== null) out.push(entry as Record<string, unknown>);
    }
  }
  return out;
}

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

async function armScenario(api: APIRequestContext, projectPath: string, scenario: unknown): Promise<ArmedSession> {
  const response = await api.post('/api/debug-agent/scenarios', { data: { projectPath, scenario } });
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`arming failed (${response.status()}): ${JSON.stringify(body)}`);
  }
  const data = body?.data;
  if (typeof data?.sessionId !== 'string' || typeof data?.transcriptPath !== 'string') {
    throw new Error(`arming returned no sessionId/transcriptPath: ${JSON.stringify(body)}`);
  }
  return { sessionId: data.sessionId, transcriptPath: data.transcriptPath };
}

async function startResidentProcess(api: APIRequestContext, sessionId: string): Promise<void> {
  const response = await api.post(`/api/session-hosts/${encodeURIComponent(sessionId)}/start`);
  if (!response.ok()) {
    throw new Error(
      `could not start the resident process for ${sessionId}: ${response.status()} ${await response.text()}`,
    );
  }
}

/** Fires a walk; never awaited before a reading (it parks for minutes past this case). */
function fireClock(api: APIRequestContext, sessionId: string) {
  return api
    .post('/api/debug-agent/clock', { data: { sessionId } })
    .then(async (response) => ({ ok: response.ok(), status: response.status() }))
    .catch((error: unknown) => ({ ok: false, status: -1, failed: String(error) }));
}

const phase = async (page: Page): Promise<string> =>
  ((await page.getByTestId('voice-realtime-phase').textContent()) ?? '').trim();

const waitForPhase = (page: Page, wanted: string) =>
  expect.poll(() => phase(page), { timeout: 25_000 }).toBe(wanted);

async function enterLiveVoice(page: Page): Promise<void> {
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 30_000 });
  const entry = page.getByTestId('live-voice-button');
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await entry.click();
  await expect(page.locator(VOICE_BAR)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeHidden();
}

async function openSession(page: Page, sessionId: string): Promise<void> {
  await page.goto(`/session/${sessionId}`);
  await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 30_000 });
}

/**
 * Has the endpoint close an utterance with `text`, and waits until the bar is showing those words.
 *
 * The page rendering the caption is the ordering barrier: the proxy sends the `caption` frame and
 * records the final in the same synchronous step, so the settle window this case depends on is
 * armed by the time this returns.
 */
async function hearUtterance(page: Page, upstream: ScriptedUpstreamServer, itemId: string, text: string): Promise<void> {
  upstream.emit(captionCompleted(itemId, text));
  await expect(page.getByTestId('voice-realtime-caption')).toContainText(text, { timeout: 15_000 });
}

test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.describe('live voice settles and delivers without a command row', () => {
  let page: Page;
  let api: APIRequestContext;
  let upstream: ScriptedUpstreamServer;
  let workspacePath = '';
  let workspaceName = '';

  test.beforeAll(async ({ browser }) => {
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');
    const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
    if (!fixtureHome) throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME');
    const upstreamPort = Number(process.env.QUAY_E2E_VOICE_REALTIME_PORT);
    if (!Number.isInteger(upstreamPort) || upstreamPort <= 0) {
      throw new Error('playwright.config.ts must publish QUAY_E2E_VOICE_REALTIME_PORT for this selection');
    }
    // The producer under test lives on the CONTINUOUS wire; the config arms it for this selection.
    // A run that lost that arming would silently measure the segmented relay, so it fails loudly.
    if (process.env.QUAY_E2E_VOICE_REALTIME_MODE !== 'continuous') {
      throw new Error('this criterion must run with QUAY_E2E_VOICE_REALTIME_MODE=continuous');
    }

    upstream = await startScriptedUpstream(upstreamPort);

    workspacePath = path.join(fixtureHome, 'live-voice-stream-workspace');
    workspaceName = path.basename(workspacePath);

    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();

    api = await request.newContext({ baseURL: clientUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });

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
    await context.addInitScript(recordSocketFrames);

    page = await context.newPage();
    await page.route('**/api/voice/health', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true }) }),
    );
  });

  test.afterAll(async () => {
    await page?.close();
    await api?.dispose();
    await upstream?.close();
  });

  test('a heard sentence the model never answers is delivered verbatim, drawn as a read-only card, and never as a withdrawable command', async () => {
    const armed = await armScenario(api, workspacePath, STREAM_SCENARIO);
    await startResidentProcess(api, armed.sessionId);

    await page.goto('/');
    if (
      !(await projectRow(page, workspaceName)
        .waitFor({ state: 'visible', timeout: 25_000 })
        .then(() => true, () => false))
    ) {
      await page.reload();
    }
    await revealSession(page, workspaceName, armed.sessionId);
    await sessionRow(page, armed.sessionId).click();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });

    await enterLiveVoice(page);
    await waitForPhase(page, 'listening');
    void fireClock(api, armed.sessionId);

    // ---- the sentence is HEARD and the model never answers it ----------------------------------
    // The scripted endpoint emits the final transcription and then opens no response and calls no
    // tool. Under the pre-settle producer this arm delivered NOTHING (journal `764f0c7a`).
    await hearUtterance(page, upstream, ITEM_ID, SPOKEN);

    // ---- the relay HOLDS it while the session is busy: the ONE read-only card ------------------
    await expect.poll(() => page.locator(HELD_CARD).count(), { timeout: 20_000 }).toBe(1);
    console.log(`reading.cardCount=${await page.locator(HELD_CARD).count()}`);

    // ---- the endpoint has stopped speaking: the hold's quiet window releases it -----------------
    upstream.emit(speechStopped(ITEM_ID, 0));

    // A QUEUED delivery is the host's own statement that the spoken sentence reached its queue.
    await expect
      .poll(async () => (await sentDeliveries(page)).filter((delivery) => delivery.text.includes(SPOKEN)).length, {
        timeout: 25_000,
        message: 'the settled sentence never reached the session (no `sent` frame carrying it)',
      })
      .toBe(1);
    const delivery = (await sentDeliveries(page)).find((candidate) => candidate.text.includes(SPOKEN))!;
    console.log(`reading.deliveredText=${JSON.stringify(delivery.text.slice(0, 120))}`);
    console.log(`reading.deliveryId=${delivery.deliveryId ?? '<null>'} queuedUuid=${delivery.uuid ?? '<null>'}`);
    expect(delivery.text).toBe(SPOKEN);
    expect(delivery.uuid, 'the delivery must be a QUEUED command the substitute process holds').not.toBeNull();

    // ---- the activity snapshot carried it as a VOICE delivery (non-vacuity) ---------------------
    // Without this reading, "no withdraw row" would also hold on a snapshot that carried no
    // delivery at all. The debug provider publishes its ledger through the same seam the real
    // resident driver uses, and the origin is the voice plane's.
    await expect
      .poll(
        async () =>
          (await activityDeliveries(page)).filter(
            (entry) =>
              entry.source === 'voice'
              && (entry.deliveryId === delivery.deliveryId || entry.deliveryId === delivery.uuid),
          ).length,
        { timeout: 20_000, message: 'the activity channel never carried the voice delivery' },
      )
      .toBeGreaterThanOrEqual(1);
    const voiceEntries = (await activityDeliveries(page)).filter((entry) => entry.source === 'voice');
    console.log(`reading.voiceDeliveries=${voiceEntries.length}`);

    // ---- the representation: no command row, no withdraw --------------------------------------
    const columns = await page.evaluate(
      ({ withdraw, row, deliveryId }) => ({
        withdraw: document.querySelectorAll(withdraw).length,
        deliveryRows: document.querySelectorAll(row).length,
        thisDeliveryRows: deliveryId === '' ? 0 : document.querySelectorAll(`[data-delivery-id="${deliveryId}"]`).length,
      }),
      { withdraw: WITHDRAW, row: DELIVERY_ROW, deliveryId: delivery.deliveryId ?? '' },
    );
    console.log(`reading.withdrawControls=${columns.withdraw} deliveryRows=${columns.deliveryRows} thisDeliveryRows=${columns.thisDeliveryRows}`);
    expect(columns.withdraw, 'a spoken sentence must never draw a withdrawable command row').toBe(0);
    expect(columns.thisDeliveryRows, 'the voice delivery must not be drawn as a pending command').toBe(0);

    // ---- the real user message, after the held turn ends ---------------------------------------
    // The walk opens a turn carrying the same words at 16 s; that row is a normal transcript user
    // message (not a delivery row), and it has no withdraw button either.
    const userRow = page.locator(USER_ROW).filter({ hasText: SPOKEN }).first();
    await expect(userRow, 'the spoken sentence must appear as a real user message').toBeVisible({ timeout: 40_000 });
    expect(await userRow.locator(WITHDRAW).count(), 'the real user message carries no withdraw control').toBe(0);

    // A held card is a WAIT, not a message: once the delivery has landed the card is gone, and the
    // transcript's user row is the only place the words are drawn.
    let cards = await page.locator(HELD_CARD).allTextContents();
    const deadline = Date.now() + 25_000;
    while (cards.length > 0 && Date.now() < deadline) {
      await page.waitForTimeout(250);
      cards = await page.locator(HELD_CARD).allTextContents();
    }
    console.log(`reading.finalCards=${JSON.stringify(cards)}`);
    expect(cards, 'the waiting card must come down once the delivery has been consumed').toHaveLength(0);
  });
});
